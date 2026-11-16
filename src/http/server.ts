import fs from 'fs';
import path from 'path';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { config, isSecureOrigin } from '../config';
import {
  beginLogin,
  beginRegistration,
  checkSetupCode,
  enrollmentOpen,
  finishLogin,
  finishRegistration,
  passkeyCount,
} from '../auth/passkeys';
import { createSession, destroySession, isValidSession, SESSION_COOKIE } from '../auth/sessions';
import {
  addContact,
  Contact,
  deleteContact,
  findContactByNickname,
  getAllContacts,
  updateContact,
} from '../contacts/store';
import { parseCommand } from '../parser/regex';
import { getGHSBalance, isValidWebhookSignature } from '../payment/paystack';
import { getTodaySpendingPesewas } from '../payment/validator';
import {
  beginConfirm,
  cancelQuote,
  confirmTransfer,
  createQuote,
  getTransaction,
  reconcileByReference,
  submitOtp,
} from '../transfers/service';
import { listTx, toView } from '../transfers/store';
import { UserError } from '../utils/errors';
import { logger } from '../utils/logger';
import { toPesewas } from '../utils/money';
import { detectNetwork, networkLabel, toLocal } from '../utils/phone';

const CHALLENGE_COOKIE = 'es_challenge';

/** Routes that work without a session. Everything else under /api needs one. */
const PUBLIC_API = [/^\/api\/session$/, /^\/api\/auth\//, /^\/api\/webhooks\//];

function contactView(c: Contact) {
  const network = detectNetwork(c.phone);
  return {
    id: c.id,
    nickname: c.nickname,
    phone: toLocal(c.phone),
    network,
    networkLabel: network ? networkLabel(network) : null,
  };
}

/** Parse "50", "50.5" or 50 into pesewas without trusting floating point input. */
function parseAmount(value: unknown): number {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) throw new UserError('Enter an amount like 50 or 50.50.');
  const [whole, frac = ''] = text.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

function idParam(req: FastifyRequest): number {
  const id = Number((req.params as { id?: string }).id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new UserError('Not found.', 404);
  return id;
}

function body(req: FastifyRequest): Record<string, any> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, any>) : {};
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: true });
  await app.register(cookie);

  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: isSecureOrigin,
  };

  // Keep the raw JSON text around: Paystack signs the exact bytes of its webhooks.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, raw, done) => {
    (req as any).rawBody = raw;
    if (raw === '') return done(null, {});
    try {
      done(null, JSON.parse(raw as string));
    } catch {
      done(new UserError('Invalid JSON.'), undefined);
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );

    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-cache');
      return;
    }
    reply.header('Cache-Control', 'no-store');

    if (url.startsWith('/api/webhooks/')) return;

    // Cross-site requests cannot carry the SameSite=Strict cookie, but refuse them outright anyway.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && origin !== config.appOrigin) {
        return reply.code(403).send({ error: 'Request came from an unexpected origin.' });
      }
    }

    if (PUBLIC_API.some(re => re.test(url))) return;
    if (!isValidSession(req.cookies[SESSION_COOKIE])) {
      return reply.code(401).send({ error: 'Sign in to continue.' });
    }
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof UserError) return reply.code(err.statusCode).send({ error: err.message });
    if (err?.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    logger.error(err, 'Unhandled request error');
    return reply.code(500).send({ error: 'Something went wrong on the server.' });
  });

  app.get('/healthz', async () => ({ ok: true }));

  // --- Session and passkeys ---------------------------------------------------

  app.get('/api/session', async req => ({
    authenticated: isValidSession(req.cookies[SESSION_COOKIE]),
    setupRequired: passkeyCount() === 0,
    enrollmentOpen: enrollmentOpen(),
  }));

  function signIn(reply: FastifyReply): void {
    reply.setCookie(SESSION_COOKIE, createSession(), {
      ...cookieOptions,
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    });
    reply.clearCookie(CHALLENGE_COOKIE, cookieOptions);
  }

  app.post('/api/auth/register/options', async (req, reply) => {
    checkSetupCode(body(req).setupCode);
    const { challengeId, options } = await beginRegistration();
    reply.setCookie(CHALLENGE_COOKIE, challengeId, { ...cookieOptions, maxAge: 300 });
    return options;
  });

  app.post('/api/auth/register/verify', async (req, reply) => {
    // The code is checked again so a stolen challenge cookie alone enrolls nothing.
    checkSetupCode(body(req).setupCode);
    await finishRegistration(req.cookies[CHALLENGE_COOKIE], body(req).response, body(req).label);
    signIn(reply);
    return { ok: true };
  });

  app.post('/api/auth/login/options', async (_req, reply) => {
    if (passkeyCount() === 0) throw new UserError('No passkey has been set up yet.', 409);
    const { challengeId, options } = await beginLogin();
    reply.setCookie(CHALLENGE_COOKIE, challengeId, { ...cookieOptions, maxAge: 300 });
    return options;
  });

  app.post('/api/auth/login/verify', async (req, reply) => {
    await finishLogin(req.cookies[CHALLENGE_COOKIE], body(req).response);
    signIn(reply);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    destroySession(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return { ok: true };
  });

  // --- Balance and limits -----------------------------------------------------

  app.get('/api/balance', async () => {
    const limits = {
      perTransactionPesewas: toPesewas(config.perTransactionLimitGHS),
      dailyPesewas: toPesewas(config.dailyLimitGHS),
      spentTodayPesewas: getTodaySpendingPesewas(),
    };
    try {
      const balancePesewas = await getGHSBalance();
      return {
        balancePesewas,
        low: balancePesewas < toPesewas(config.lowBalanceAlertGHS),
        autoFund: config.autoFund,
        limits,
      };
    } catch (err: any) {
      logger.warn('Balance check failed: %s', err?.message);
      return { balancePesewas: null, low: false, autoFund: config.autoFund, limits };
    }
  });

  // --- Contacts ---------------------------------------------------------------

  app.get('/api/contacts', async () => ({ contacts: getAllContacts().map(contactView) }));

  app.post('/api/contacts', async (req, reply) => {
    const contact = addContact(body(req).nickname, body(req).phone);
    reply.code(201);
    return { contact: contactView(contact) };
  });

  app.patch('/api/contacts/:id', async req => {
    const { nickname, phone } = body(req);
    return { contact: contactView(updateContact(idParam(req), { nickname, phone })) };
  });

  app.delete('/api/contacts/:id', async req => {
    deleteContact(idParam(req));
    return { ok: true };
  });

  // --- Typed commands ("send 50 to Kojo") ---------------------------------------

  app.post('/api/command', async req => {
    const text = String(body(req).text ?? '').slice(0, 200);
    const cmd = parseCommand(text);

    switch (cmd.type) {
      case 'SEND': {
        if (!cmd.amount || (!cmd.recipient && !cmd.recipientPhone)) {
          throw new UserError('Try something like "send 50 to Kojo" or "send 30 to 0241234567".');
        }
        const amount = cmd.amount.toFixed(2);
        if (cmd.recipientPhone) return { action: 'send', amount, phone: cmd.recipientPhone };
        const contact = findContactByNickname(cmd.recipient!);
        if (!contact) return { action: 'unknown_contact', name: cmd.recipient, amount };
        return { action: 'send', amount, contactId: contact.id };
      }
      case 'ADD_CONTACT':
        return { action: 'contact_added', contact: contactView(addContact(cmd.contactName!, cmd.contactPhone!)) };
      case 'BALANCE':
        return { action: 'home' };
      case 'HISTORY':
        return { action: 'activity' };
      case 'CONTACTS':
        return { action: 'contacts' };
      default:
        throw new UserError('Try something like "send 50 to Kojo" or "send 30 to 0241234567".');
    }
  });

  // --- Transfers --------------------------------------------------------------

  app.post('/api/quotes', async (req, reply) => {
    const { amount, contactId, phone } = body(req);
    const quote = await createQuote({
      amountPesewas: parseAmount(amount),
      contactId: contactId == null ? null : Number(contactId),
      phone: phone == null ? null : String(phone),
    });
    reply.code(201);
    return quote;
  });

  app.get('/api/transactions', async req => {
    const limit = Math.min(Math.max(Number((req.query as any)?.limit) || 30, 1), 100);
    return { transactions: listTx(limit).map(toView) };
  });

  app.get('/api/transactions/:id', async req => ({ transaction: getTransaction(idParam(req)) }));

  app.post('/api/transactions/:id/confirm/options', async req => beginConfirm(idParam(req)));

  app.post('/api/transactions/:id/confirm', async req => ({
    transaction: await confirmTransfer(idParam(req), body(req).response),
  }));

  app.post('/api/transactions/:id/cancel', async req => ({ transaction: cancelQuote(idParam(req)) }));

  app.post('/api/transactions/:id/otp', async req => ({
    transaction: await submitOtp(idParam(req), body(req).otp),
  }));

  // --- Paystack webhook -------------------------------------------------------
  // The payload is only used as a hint: we look the reference up at Paystack
  // ourselves, so a forged or replayed event cannot change a transfer's state.

  app.post('/api/webhooks/paystack', async (req, reply) => {
    const signature = req.headers['x-paystack-signature'];
    const raw = (req as any).rawBody as string | undefined;
    if (!raw || !isValidWebhookSignature(raw, Array.isArray(signature) ? signature[0] : signature)) {
      return reply.code(401).send({ error: 'Bad signature.' });
    }
    const event = body(req);
    const reference = event?.data?.reference;
    if (typeof reference === 'string' && /^(transfer|charge)\./.test(String(event.event))) {
      reconcileByReference(reference).catch(err =>
        logger.warn('Webhook reconcile failed for %s: %s', reference, err?.message)
      );
    }
    return { ok: true };
  });

  app.all('/api/*', async (_req, reply) => reply.code(404).send({ error: 'Not found.' }));

  // --- The app itself -----------------------------------------------------------

  if (fs.existsSync(config.publicDir)) {
    await app.register(fastifyStatic, {
      root: config.publicDir,
      // The service worker handles offline caching; always revalidate with the server.
      cacheControl: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !path.extname(req.url.split('?')[0])) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found.' });
    });
  }

  return app;
}
