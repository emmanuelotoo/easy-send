import './helpers/env';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../src/config';
import { closeDb, getDb, runMigrations } from '../src/db/client';
import { buildServer } from '../src/http/server';
import { reconcileActive } from '../src/transfers/service';
import { MockPaystack, startMockPaystack } from '../scripts/mock-paystack';
import { TestAuthenticator } from './helpers/authenticator';

const SETTLE_MS = 15;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let app: FastifyInstance;
let mock: MockPaystack;
const passkey = new TestAuthenticator('http://localhost:3000', 'localhost');
const cookies = new Map<string, string>();

async function api(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: method as any,
    url,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      ...headers,
    },
  });
  for (const c of res.cookies) {
    if (c.value) cookies.set(c.name, c.value);
    else cookies.delete(c.name);
  }
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

/** Quote, then confirm with the passkey. Returns the transaction after confirmation. */
async function send(amount: string, target: { contactId?: number; phone?: string }) {
  const quote = await api('POST', '/api/quotes', { amount, ...target });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const id = quote.body.transaction.id as number;
  const options = await api('POST', `/api/transactions/${id}/confirm/options`, {});
  const confirmed = await api('POST', `/api/transactions/${id}/confirm`, { response: passkey.assert(options.body) });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return confirmed.body.transaction;
}

/** Let the mock settle, then run reconcile passes until the transfer reaches a status. */
async function waitFor(id: number, statuses: string[]) {
  for (let i = 0; i < 40; i++) {
    const { body } = await api('GET', `/api/transactions/${id}`);
    if (statuses.includes(body.transaction.status)) return body.transaction;
    await sleep(SETTLE_MS);
    await reconcileActive({ force: true });
  }
  const { body } = await api('GET', `/api/transactions/${id}`);
  assert.fail(`transfer ${id} stuck in "${body.transaction.status}", wanted ${statuses.join(' or ')}`);
}

const transferPosts = () => mock.state.requests.filter(r => r === 'POST /transfer').length;

before(async () => {
  mock = await startMockPaystack({ settleMs: SETTLE_MS });
  config.paystackBaseUrl = mock.url;
  runMigrations();
  app = await buildServer();
});

after(async () => {
  await app.close();
  await mock.close();
  closeDb();
});

beforeEach(() => {
  getDb().exec('DELETE FROM transactions');
  Object.assign(mock.state, {
    balance: 100_000,
    transferOtp: false,
    chargeOtp: false,
    autoApproveCharges: true,
    creditChargesToBalance: true,
    dropNextTransferResponse: false,
  });
  mock.state.requests.length = 0;
  mock.state.charges.clear();
  mock.state.transfers.clear();
  config.fundingTimeoutMs = 4 * 60 * 1000;
});

// --- Access control ---------------------------------------------------------------

test('nothing is readable before sign-in', async () => {
  const session = await api('GET', '/api/session');
  assert.deepEqual(session.body, { authenticated: false, setupRequired: true, enrollmentOpen: true });

  for (const url of ['/api/balance', '/api/contacts', '/api/transactions']) {
    assert.equal((await api('GET', url)).status, 401, url);
  }
  assert.equal((await api('POST', '/api/quotes', { amount: '10', phone: '0241234567' })).status, 401);
});

test('a passkey can only be enrolled with the setup code', async () => {
  const wrong = await api('POST', '/api/auth/register/options', { setupCode: 'nope' });
  assert.equal(wrong.status, 401);

  const options = await api('POST', '/api/auth/register/options', { setupCode: config.setupCode });
  assert.equal(options.status, 200);
  assert.equal(options.body.rp.id, 'localhost');
  assert.equal(options.body.authenticatorSelection.userVerification, 'required');

  const noCode = await api('POST', '/api/auth/register/verify', { response: passkey.register(options.body) });
  assert.equal(noCode.status, 401);

  const again = await api('POST', '/api/auth/register/options', { setupCode: config.setupCode });
  const done = await api('POST', '/api/auth/register/verify', {
    setupCode: config.setupCode,
    response: passkey.register(again.body),
    label: 'Test phone',
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));

  const session = await api('GET', '/api/session');
  assert.equal(session.body.authenticated, true);
  assert.equal(session.body.setupRequired, false);
});

test('sign out, then sign back in with the passkey', async () => {
  await api('POST', '/api/auth/logout', {});
  assert.equal((await api('GET', '/api/contacts')).status, 401);

  const options = await api('POST', '/api/auth/login/options', {});
  const stranger = new TestAuthenticator('http://localhost:3000', 'localhost');
  assert.equal((await api('POST', '/api/auth/login/verify', { response: stranger.assert(options.body) })).status, 401);

  // The failed attempt burned the challenge, so a fresh one is needed.
  const stale = await api('POST', '/api/auth/login/verify', { response: passkey.assert(options.body) });
  assert.equal(stale.status, 400);

  const fresh = await api('POST', '/api/auth/login/options', {});
  const ok = await api('POST', '/api/auth/login/verify', { response: passkey.assert(fresh.body) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await api('GET', '/api/contacts')).status, 200);
});

test('requests from another origin are refused', async () => {
  const res = await api('POST', '/api/contacts', { nickname: 'Evil', phone: '0241234567' }, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

// --- Contacts and commands ----------------------------------------------------------

test('contacts: add, validate, rename, delete', async () => {
  const added = await api('POST', '/api/contacts', { nickname: '  Auntie  Esi ', phone: '024 123 4567' });
  assert.equal(added.status, 201);
  assert.deepEqual(
    { ...added.body.contact, id: 0 },
    { id: 0, nickname: 'Auntie Esi', phone: '024 123 4567', network: 'mtn', networkLabel: 'MTN' }
  );
  const id = added.body.contact.id;

  assert.equal((await api('POST', '/api/contacts', { nickname: 'auntie esi', phone: '0551234567' })).status, 409);
  assert.equal((await api('POST', '/api/contacts', { nickname: 'Bad', phone: '0301234567' })).status, 400);
  assert.equal((await api('POST', '/api/contacts', { nickname: '12345', phone: '0241234567' })).status, 400);

  const renamed = await api('PATCH', `/api/contacts/${id}`, { nickname: 'Esi', phone: '0201234567' });
  assert.equal(renamed.body.contact.nickname, 'Esi');
  assert.equal(renamed.body.contact.network, 'telecel');

  assert.equal((await api('DELETE', `/api/contacts/${id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/contacts/${id}`)).status, 404);
});

test('typed commands resolve to actions', async () => {
  const kojo = (await api('POST', '/api/contacts', { nickname: 'Kojo', phone: '0241234567' })).body.contact;

  assert.deepEqual((await api('POST', '/api/command', { text: 'send 50 to kojo' })).body, {
    action: 'send',
    amount: '50.00',
    contactId: kojo.id,
  });
  assert.deepEqual((await api('POST', '/api/command', { text: 'send twenty cedis to 0551234567' })).body, {
    action: 'send',
    amount: '20.00',
    phone: '0551234567',
  });
  assert.equal((await api('POST', '/api/command', { text: 'send 5 to nobody' })).body.action, 'unknown_contact');
  assert.equal((await api('POST', '/api/command', { text: 'history' })).body.action, 'activity');
  assert.equal((await api('POST', '/api/command', { text: 'make me a sandwich' })).status, 400);
});

// --- Sending ------------------------------------------------------------------------

test('a send needs the passkey, shows the verified name, and settles to success', async () => {
  const kojo = (await api('GET', '/api/contacts')).body.contacts.find((c: any) => c.nickname === 'Kojo');

  const quote = await api('POST', '/api/quotes', { amount: '50', contactId: kojo.id });
  assert.equal(quote.status, 201);
  const tx = quote.body.transaction;
  assert.equal(tx.status, 'quoted');
  assert.equal(tx.amountPesewas, 5000);
  assert.equal(tx.feePesewas, 100);
  assert.equal(tx.recipientName, 'Kojo');
  assert.equal(tx.verifiedName, 'KOJO MENSAH');
  assert.equal(quote.body.funding, null);
  assert.ok(!('challenge' in tx), 'the challenge must never be in a transaction view');

  // No passkey step at all.
  assert.equal((await api('POST', `/api/transactions/${tx.id}/confirm`, { response: {} })).status, 400);

  // A passkey answer that skipped fingerprint / PIN verification.
  let options = await api('POST', `/api/transactions/${tx.id}/confirm/options`, {});
  assert.equal(options.body.userVerification, 'required');
  const weak = await api('POST', `/api/transactions/${tx.id}/confirm`, { response: passkey.assert(options.body, false) });
  assert.equal(weak.status, 401);
  assert.equal(transferPosts(), 0);

  options = await api('POST', `/api/transactions/${tx.id}/confirm/options`, {});
  const confirmed = await api('POST', `/api/transactions/${tx.id}/confirm`, { response: passkey.assert(options.body) });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.transaction.status, 'pending');
  assert.equal(mock.state.balance, 100_000 - 5100);

  // The same quote cannot be confirmed twice.
  assert.equal((await api('POST', `/api/transactions/${tx.id}/confirm/options`, {})).status, 409);

  const settled = await waitFor(tx.id, ['success']);
  assert.equal(settled.failureReason, null);
  assert.equal(transferPosts(), 1);

  const history = await api('GET', '/api/transactions');
  assert.equal(history.body.transactions.length, 1);
  assert.equal(history.body.transactions[0].id, tx.id);

  const balance = await api('GET', '/api/balance');
  assert.equal(balance.body.balancePesewas, 100_000 - 5100);
  assert.equal(balance.body.limits.spentTodayPesewas, 5000);
});

test("a passkey answer for one quote cannot confirm another", async () => {
  const a = (await api('POST', '/api/quotes', { amount: '5', phone: '0241234567' })).body.transaction;
  const b = (await api('POST', '/api/quotes', { amount: '150', phone: '0551234567' })).body.transaction;

  const optionsA = await api('POST', `/api/transactions/${a.id}/confirm/options`, {});
  await api('POST', `/api/transactions/${b.id}/confirm/options`, {});

  const crossed = await api('POST', `/api/transactions/${b.id}/confirm`, { response: passkey.assert(optionsA.body) });
  assert.equal(crossed.status, 401);
  assert.equal(transferPosts(), 0);
});

test('quotes expire and can be cancelled', async () => {
  const expired = (await api('POST', '/api/quotes', { amount: '10', phone: '0241234567' })).body.transaction;
  getDb().prepare('UPDATE transactions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expired.id);
  assert.equal((await api('POST', `/api/transactions/${expired.id}/confirm/options`, {})).status, 410);
  assert.equal((await api('GET', `/api/transactions/${expired.id}`)).body.transaction.status, 'expired');

  const cancelled = (await api('POST', '/api/quotes', { amount: '10', phone: '0241234567' })).body.transaction;
  assert.equal((await api('POST', `/api/transactions/${cancelled.id}/cancel`, {})).body.transaction.status, 'cancelled');
  assert.equal((await api('POST', `/api/transactions/${cancelled.id}/confirm/options`, {})).status, 409);

  assert.equal((await api('GET', '/api/transactions')).body.transactions.length, 0);
});

test('limits and bad input are rejected before anything is quoted', async () => {
  const over = await api('POST', '/api/quotes', { amount: '200.01', phone: '0241234567' });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /per-send limit/);

  for (const amount of ['0', '-5', 'abc', '1e3', '10.999', '']) {
    assert.equal((await api('POST', '/api/quotes', { amount, phone: '0241234567' })).status, 400, `amount "${amount}"`);
  }
  assert.equal((await api('POST', '/api/quotes', { amount: '10', phone: '0301234567' })).status, 400);
  assert.equal((await api('POST', '/api/quotes', { amount: '10' })).status, 400);

  // Daily limit is 500: two sends of 200 leave room for 100.
  await send('200', { phone: '0241234567' });
  await send('200', { phone: '0241234567' });
  const third = await api('POST', '/api/quotes', { amount: '150', phone: '0241234567' });
  assert.equal(third.status, 400);
  assert.match(third.body.error, /daily limit.*GHS 100\.00/);
  assert.equal((await api('POST', '/api/quotes', { amount: '100', phone: '0241234567' })).status, 201);
});

test('an unverifiable number is still quotable, without a verified name', async () => {
  const quote = await api('POST', '/api/quotes', { amount: '10', phone: '0241230000' });
  assert.equal(quote.status, 201);
  assert.equal(quote.body.transaction.verifiedName, null);
  assert.equal(quote.body.transaction.recipientName, '024 123 0000');
});

test('a transfer that fails at the network is reported as failed', async () => {
  const tx = await send('30', { phone: '0241239999' });
  assert.equal(tx.status, 'pending');
  const settled = await waitFor(tx.id, ['failed']);
  assert.match(settled.failureReason, /Recipient wallet cannot receive funds/);
  assert.equal(mock.state.balance, 100_000, 'the mock refunds a failed transfer');
  assert.equal((await api('GET', '/api/balance')).body.limits.spentTodayPesewas, 0);
});

test('an unknown transfer outcome is verified, never retried', async () => {
  mock.state.dropNextTransferResponse = true;
  const tx = await send('40', { phone: '0241234567' });
  assert.equal(tx.status, 'sending', 'a 502 must not be treated as a failure');

  const settled = await waitFor(tx.id, ['success']);
  assert.equal(settled.status, 'success');
  assert.equal(transferPosts(), 1, 'the transfer must be created exactly once');
  assert.equal(mock.state.balance, 100_000 - 4100);
});

test('Paystack transfer OTP: wrong code is rejected, right code completes the send', async () => {
  mock.state.transferOtp = true;
  const tx = await send('25', { phone: '0551234567' });
  assert.equal(tx.status, 'otp');
  assert.match(tx.prompt, /OTP/);

  const wrong = await api('POST', `/api/transactions/${tx.id}/otp`, { otp: '000000' });
  assert.equal(wrong.status, 400);
  assert.equal((await api('GET', `/api/transactions/${tx.id}`)).body.transaction.status, 'otp');

  const right = await api('POST', `/api/transactions/${tx.id}/otp`, { otp: '123456' });
  assert.equal(right.body.transaction.status, 'pending');
  await waitFor(tx.id, ['success']);
});

// --- Topping up from the wallet -------------------------------------------------------

test('a short balance is topped up from the wallet, then the send goes out', async () => {
  mock.state.balance = 1000;

  const quote = await api('POST', '/api/quotes', { amount: '50', phone: '0241234567' });
  const funding = quote.body.funding;
  assert.equal(funding.balancePesewas, 1000);
  assert.equal(funding.shortfallPesewas, 4100);
  assert.equal(funding.autoFund, true);
  assert.ok(funding.chargeAmountPesewas > 4100 && funding.extraFeePesewas > 0);

  const id = quote.body.transaction.id;
  const options = await api('POST', `/api/transactions/${id}/confirm/options`, {});
  const confirmed = await api('POST', `/api/transactions/${id}/confirm`, { response: passkey.assert(options.body) });
  assert.equal(confirmed.body.transaction.status, 'funding');
  assert.equal(confirmed.body.transaction.chargeAmountPesewas, funding.chargeAmountPesewas);
  assert.equal(transferPosts(), 0, 'nothing is sent before the wallet charge clears');

  await waitFor(id, ['success']);
  assert.equal(transferPosts(), 1);
  assert.ok(mock.state.balance >= 0);
});

test('a wallet charge that asks for an OTP', async () => {
  mock.state.balance = 0;
  mock.state.chargeOtp = true;
  const tx = await send('20', { phone: '0241234567' });
  assert.equal(tx.status, 'funding_otp');

  assert.equal((await api('POST', `/api/transactions/${tx.id}/otp`, { otp: 'abc' })).status, 400);
  assert.equal((await api('POST', `/api/transactions/${tx.id}/otp`, { otp: '999999' })).status, 400);
  const ok = await api('POST', `/api/transactions/${tx.id}/otp`, { otp: '123456' });
  assert.equal(ok.body.transaction.status, 'funding');
  await waitFor(tx.id, ['success']);
});

test('an ignored wallet prompt times out without sending anything', async () => {
  mock.state.balance = 0;
  mock.state.autoApproveCharges = false;
  const tx = await send('20', { phone: '0241234567' });
  assert.equal(tx.status, 'funding');

  config.fundingTimeoutMs = 0;
  const settled = await waitFor(tx.id, ['failed']);
  assert.match(settled.failureReason, /not approved in time/);
  assert.equal(transferPosts(), 0);
});

test('a charge that never reaches the transfer balance fails with a clear reason', async () => {
  mock.state.balance = 0;
  mock.state.creditChargesToBalance = false;
  const tx = await send('20', { phone: '0241234567' });

  await sleep(SETTLE_MS * 3);
  await reconcileActive({ force: true });
  assert.equal((await api('GET', `/api/transactions/${tx.id}`)).body.transaction.status, 'funding');

  config.fundingTimeoutMs = 0;
  const settled = await waitFor(tx.id, ['failed']);
  assert.match(settled.failureReason, /manual payouts/);
  assert.equal(transferPosts(), 0);
});

test('with auto-fund off, a short balance fails cleanly', async () => {
  mock.state.balance = 0;
  config.autoFund = false;
  try {
    const quote = await api('POST', '/api/quotes', { amount: '20', phone: '0241234567' });
    assert.equal(quote.body.funding.autoFund, false);
    const tx = await send('20', { phone: '0241234567' });
    assert.equal(tx.status, 'failed');
    assert.match(tx.failureReason, /Top up/);
    assert.equal(mock.state.charges.size, 0);
  } finally {
    config.autoFund = true;
  }
});

// --- Webhooks -----------------------------------------------------------------------

test('webhooks need a valid signature and only trigger a lookup', async () => {
  const tx = await send('15', { phone: '0241234567' });
  await sleep(SETTLE_MS * 3);

  const payload = JSON.stringify({ event: 'transfer.failed', data: { reference: tx.reference } });
  const forged = await app.inject({
    method: 'POST',
    url: '/api/webhooks/paystack',
    payload,
    headers: { 'content-type': 'application/json', 'x-paystack-signature': 'deadbeef' },
  });
  assert.equal(forged.statusCode, 401);

  // Correctly signed, but lying about the outcome: the real status wins.
  const signature = crypto.createHmac('sha512', config.paystackSecretKey).update(payload).digest('hex');
  const signed = await app.inject({
    method: 'POST',
    url: '/api/webhooks/paystack',
    payload,
    headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
  });
  assert.equal(signed.statusCode, 200);
  await sleep(50);
  assert.equal((await api('GET', `/api/transactions/${tx.id}`)).body.transaction.status, 'success');
});
