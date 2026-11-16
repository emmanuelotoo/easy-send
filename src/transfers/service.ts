import { config } from '../config';
import { getDb } from '../db/client';
import { buildAssertionOptions, verifyAssertion } from '../auth/passkeys';
import { findContactById, updateRecipientCode } from '../contacts/store';
import { computeChargeAmount, TRANSFER_FEE_PESEWAS } from '../payment/fees';
import {
  chargeMobileMoney,
  checkPendingCharge,
  createRecipient,
  finalizeTransfer,
  generateReference,
  getGHSBalance,
  initiateTransfer,
  PaystackApiError,
  resolveAccountName,
  resolveMomoBankCodes,
  submitChargeOtp,
  verifyTransfer,
} from '../payment/paystack';
import { PaystackCharge, PaystackTransfer } from '../payment/types';
import { validateAmount } from '../payment/validator';
import { UserError } from '../utils/errors';
import { logger } from '../utils/logger';
import { formatGHS } from '../utils/money';
import { detectNetwork, Network, networkLabel, toInternational, toLocal, toLocalDigits } from '../utils/phone';
import {
  ACTIVE_STATUSES,
  createdAtMs,
  expireStaleQuotes,
  findTxByReference,
  getTx,
  listActiveTx,
  toView,
  TransactionView,
  TxRow,
  TxStatus,
  updateTxIf,
} from './store';

/** How long an unknown outcome is given to show up at Paystack before we call it "never happened". */
const UNKNOWN_OUTCOME_GRACE_MS = 2 * 60 * 1000;
/** Stop polling transfers this old; webhooks or a manual check take over. */
const STOP_POLLING_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const NOT_FINAL: TxStatus[] = ['quoted', ...ACTIVE_STATUSES];

// --- Paystack network codes ---------------------------------------------------

let bankCodes: Record<Network, string | null> | null = null;

export async function initPaymentProvider(): Promise<void> {
  bankCodes = await resolveMomoBankCodes();
}

/** Bank codes are loaded lazily so the app still starts when Paystack is briefly down. */
async function bankCodeFor(network: Network): Promise<string | null> {
  if (!bankCodes) {
    try {
      await initPaymentProvider();
    } catch (err: any) {
      logger.warn('Could not load mobile money networks from Paystack: %s', err?.message);
      return null;
    }
  }
  return bankCodes![network];
}

// --- In-process lock ------------------------------------------------------------
// One Node process owns the database, so a Set is enough to stop the reconciler
// and a request handler from driving the same transfer at the same time.

const busy = new Set<number>();

async function withLock(id: number, fn: () => Promise<void>): Promise<boolean> {
  if (busy.has(id)) return false;
  busy.add(id);
  try {
    await fn();
  } finally {
    busy.delete(id);
  }
  return true;
}

// --- Quotes ---------------------------------------------------------------------

export interface FundingNote {
  balancePesewas: number;
  shortfallPesewas: number;
  /** What would be pulled from the owner's wallet to cover the shortfall. */
  chargeAmountPesewas: number;
  /** Paystack's collection cut plus the safety margin: the cost of not topping up first. */
  extraFeePesewas: number;
  autoFund: boolean;
}

export interface Quote {
  transaction: TransactionView;
  funding: FundingNote | null;
}

function ownerNetwork(): Network | null {
  return detectNetwork(config.ownerPhone);
}

export async function createQuote(input: {
  amountPesewas: number;
  contactId?: number | null;
  phone?: string | null;
}): Promise<Quote> {
  let contactId: number | null = null;
  let phone: string;
  let displayName: string | null = null;

  if (input.contactId != null) {
    const contact = findContactById(input.contactId);
    if (!contact) throw new UserError('That contact no longer exists.', 404);
    contactId = contact.id;
    phone = contact.phone;
    displayName = contact.nickname;
  } else if (input.phone) {
    phone = toInternational(input.phone);
  } else {
    throw new UserError('Choose who to send to.');
  }

  const network = detectNetwork(phone);
  if (!network) throw new UserError('That is not an MTN, Telecel or AirtelTigo number.');

  const validation = validateAmount(input.amountPesewas);
  if (!validation.ok) throw new UserError(validation.error!);

  const bankCode = await bankCodeFor(network);
  if (!bankCode) {
    throw new UserError(`Sending to ${networkLabel(network)} is not available right now. Try again shortly.`, 503);
  }

  const [verifiedName, balance] = await Promise.all([
    resolveAccountName(toLocalDigits(phone), bankCode),
    getGHSBalance().catch(() => null),
  ]);

  let funding: FundingNote | null = null;
  const needed = input.amountPesewas + TRANSFER_FEE_PESEWAS;
  if (balance !== null && balance < needed) {
    const chargeAmount = computeChargeAmount(input.amountPesewas - balance);
    funding = {
      balancePesewas: balance,
      shortfallPesewas: needed - balance,
      chargeAmountPesewas: chargeAmount,
      extraFeePesewas: chargeAmount - (needed - balance),
      autoFund: config.autoFund && ownerNetwork() !== null,
    };
  }

  expireStaleQuotes();
  const info = getDb()
    .prepare(
      `INSERT INTO transactions
         (contact_id, amount_pesewas, status, paystack_reference, reason, phone, network,
          recipient_name, verified_name, fee_pesewas, expires_at)
       VALUES (?, ?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      contactId,
      input.amountPesewas,
      generateReference(),
      `Easy-Send to ${displayName ?? verifiedName ?? toLocal(phone)}`,
      phone,
      network,
      displayName ?? verifiedName ?? toLocal(phone),
      verifiedName,
      TRANSFER_FEE_PESEWAS,
      Date.now() + config.quoteTtlMs
    );

  return { transaction: toView(getTx(Number(info.lastInsertRowid))!), funding };
}

function requireQuoted(id: number): TxRow {
  const tx = getTx(id);
  if (!tx) throw new UserError('Transfer not found.', 404);
  if (tx.status === 'quoted' && (tx.expires_at ?? 0) < Date.now()) {
    expireStaleQuotes();
    throw new UserError('This quote expired. Start the send again.', 410);
  }
  if (tx.status !== 'quoted') throw new UserError('This send can no longer be confirmed.', 409);
  return tx;
}

export function getTransaction(id: number): TransactionView {
  const tx = getTx(id);
  if (!tx) throw new UserError('Transfer not found.', 404);
  if (tx.status === 'quoted' && (tx.expires_at ?? 0) < Date.now()) {
    expireStaleQuotes();
    return toView(getTx(id)!);
  }
  return toView(tx);
}

export function cancelQuote(id: number): TransactionView {
  const tx = getTx(id);
  if (!tx) throw new UserError('Transfer not found.', 404);
  if (!updateTxIf(id, ['quoted'], { status: 'cancelled', challenge: null })) {
    if (tx.status !== 'cancelled' && tx.status !== 'expired') {
      throw new UserError('Too late to cancel: this send is already in progress.', 409);
    }
  }
  return toView(getTx(id)!);
}

// --- Confirmation ----------------------------------------------------------------

/** Step 1: hand the browser a passkey challenge tied to this one quote. */
export async function beginConfirm(id: number): Promise<unknown> {
  requireQuoted(id);
  const { challenge, options } = await buildAssertionOptions();
  updateTxIf(id, ['quoted'], { challenge });
  return options;
}

/** Step 2: check the passkey answer, then move the money. */
export async function confirmTransfer(id: number, assertion: unknown): Promise<TransactionView> {
  const tx = requireQuoted(id);
  if (!tx.challenge) throw new UserError('Confirm with your passkey first.');

  // The challenge is single-use whether or not the check passes.
  updateTxIf(id, ['quoted'], { challenge: null });
  await verifyAssertion(assertion, tx.challenge);

  const now = Date.now();
  const db = getDb();
  const claimed = db.transaction(() => {
    // Limits are re-checked here because other sends may have gone out since the quote.
    const validation = validateAmount(tx.amount_pesewas, id);
    if (!validation.ok) throw new UserError(validation.error!);
    const info = db
      .prepare(
        "UPDATE transactions SET status = 'sending', confirmed_at = ? WHERE id = ? AND status = 'quoted' AND expires_at > ?"
      )
      .run(now, id, now);
    return info.changes === 1;
  })();
  if (!claimed) throw new UserError('This quote is no longer valid. Start the send again.', 409);

  await withLock(id, () => start(id));
  return toView(getTx(id)!);
}

function fail(id: number, reason: string): void {
  if (updateTxIf(id, NOT_FINAL, { status: 'failed', failure_reason: reason, prompt: null })) {
    logger.warn('Transfer %d failed: %s', id, reason);
  }
}

/** A freshly confirmed send: pay from the balance, or top the balance up first. */
async function start(id: number): Promise<void> {
  const tx = getTx(id)!;
  let balance: number;
  try {
    balance = await getGHSBalance();
  } catch {
    return fail(id, 'Could not reach Paystack, so nothing was sent. Try again.');
  }

  const needed = tx.amount_pesewas + tx.fee_pesewas;
  if (balance >= needed) return executeTransfer(id);

  const network = ownerNetwork();
  if (!config.autoFund || !network) {
    return fail(
      id,
      `Your Paystack balance is ${formatGHS(balance)}, which does not cover ${formatGHS(needed)}. ` +
        'Top up on the Paystack dashboard and try again. Nothing was sent.'
    );
  }

  const chargeAmount = computeChargeAmount(tx.amount_pesewas - balance);
  const chargeReference = generateReference();
  updateTxIf(id, ['sending'], {
    status: 'funding',
    charge_reference: chargeReference,
    charge_amount_pesewas: chargeAmount,
    attempted_at: Date.now(),
    prompt: 'Approve the payment prompt on your phone.',
  });

  let charge: PaystackCharge;
  try {
    charge = await chargeMobileMoney(
      chargeAmount,
      toLocalDigits(config.ownerPhone),
      network,
      config.ownerEmail,
      chargeReference
    );
  } catch (err: any) {
    if (err instanceof PaystackApiError) {
      return fail(id, `Could not charge your wallet: ${err.message}. Nothing was sent.`);
    }
    // Outcome unknown: the reconciler looks the charge up by reference.
    logger.warn('Wallet charge for transfer %d has an unknown outcome: %s', id, err?.message);
    return;
  }
  await applyCharge(id, charge);
}

async function applyCharge(id: number, charge: PaystackCharge): Promise<void> {
  switch (charge.status) {
    case 'success':
      return afterChargeSuccess(id);
    case 'failed': {
      const why = charge.gateway_response || charge.message;
      return fail(id, `The wallet charge did not go through${why ? ` (${why})` : ''}. Nothing was sent.`);
    }
    case 'send_otp':
      updateTxIf(id, ['funding', 'funding_otp'], {
        status: 'funding_otp',
        prompt: charge.display_text || 'Enter the code sent to your phone.',
      });
      return;
    default:
      // pay_offline / pending: the owner still has to approve on their phone.
      updateTxIf(id, ['funding', 'funding_otp'], {
        status: 'funding',
        prompt: charge.display_text || 'Approve the payment prompt on your phone.',
      });
  }
}

/** The wallet charge cleared. Send once the money is actually spendable. */
async function afterChargeSuccess(id: number): Promise<void> {
  const tx = getTx(id)!;
  let balance: number;
  try {
    balance = await getGHSBalance();
  } catch {
    return; // try again on the next reconcile pass
  }

  if (balance < tx.amount_pesewas + tx.fee_pesewas) {
    if (Date.now() - (tx.confirmed_at ?? 0) > config.fundingTimeoutMs) {
      return fail(
        id,
        'Your wallet was charged, but the money has not reached your Paystack transfer balance, so nothing was sent. ' +
          'It is still in your Paystack account. Check that manual payouts are turned on in the Paystack dashboard.'
      );
    }
    updateTxIf(id, ['funding', 'funding_otp'], {
      status: 'funding',
      prompt: 'Wallet charged. Waiting for the money to reach your Paystack balance.',
    });
    return;
  }

  if (!updateTxIf(id, ['funding', 'funding_otp'], { status: 'sending', prompt: null })) return;
  return executeTransfer(id);
}

/** Create the Paystack transfer for a row that is in 'sending'. Called at most once per row. */
async function executeTransfer(id: number): Promise<void> {
  const tx = getTx(id)!;
  if (tx.status !== 'sending' || !tx.phone || !tx.network || !tx.paystack_reference) return;

  const bankCode = await bankCodeFor(tx.network);
  if (!bankCode) return fail(id, `Sending to ${networkLabel(tx.network)} is not available right now. Nothing was sent.`);

  const contact = tx.contact_id != null ? findContactById(tx.contact_id) : undefined;
  const cachedCode = contact && contact.phone === tx.phone ? contact.recipient_code : null;
  let recipientCode = cachedCode;

  if (!recipientCode) {
    try {
      const recipient = await createRecipient(
        tx.verified_name || tx.recipient_name || toLocal(tx.phone),
        toLocalDigits(tx.phone),
        bankCode
      );
      recipientCode = recipient.recipient_code;
      if (contact && contact.phone === tx.phone) updateRecipientCode(contact.id, recipientCode);
    } catch (err: any) {
      return fail(
        id,
        err instanceof PaystackApiError
          ? `Paystack could not set up the recipient: ${err.message}. Nothing was sent.`
          : 'Could not reach Paystack, so nothing was sent. Try again.'
      );
    }
  }

  updateTxIf(id, ['sending'], { attempted_at: Date.now() });

  let transfer: PaystackTransfer;
  try {
    transfer = await initiateTransfer(
      recipientCode,
      tx.amount_pesewas,
      tx.reason || `Easy-Send to ${tx.recipient_name}`,
      tx.paystack_reference
    );
  } catch (err: any) {
    if (err instanceof PaystackApiError) {
      // A cached recipient may have been removed at Paystack; make the next send recreate it.
      if (cachedCode && contact) getDb().prepare('UPDATE contacts SET recipient_code = NULL WHERE id = ?').run(contact.id);
      return fail(id, `Paystack declined the transfer: ${err.message}. Nothing was sent.`);
    }
    // Timeout or 5xx: the transfer may or may not exist. Never retry blindly;
    // the row stays in 'sending' and the reconciler verifies it by reference.
    logger.warn('Transfer %d has an unknown outcome and will be verified: %s', id, err?.message);
    return;
  }
  applyTransfer(id, transfer);
}

function describeFailure(transfer: PaystackTransfer): string {
  const detail = transfer.gateway_response || (typeof transfer.failures === 'string' ? transfer.failures : '');
  switch (transfer.status) {
    case 'abandoned':
      return 'The Paystack OTP was not entered in time, so the transfer was dropped. No money moved.';
    case 'rejected':
    case 'blocked':
      return `Paystack ${transfer.status} this transfer${detail ? ` (${detail})` : ''}. No money moved.`;
    default:
      return `The transfer failed${detail ? ` (${detail})` : ''}. The money is back in your Paystack balance.`;
  }
}

/** Fold a Paystack transfer status into our row. Safe to call repeatedly. */
function applyTransfer(id: number, transfer: PaystackTransfer): void {
  const code = transfer.transfer_code || null;
  const base = code ? { paystack_transfer_code: code } : {};
  const inFlight: TxStatus[] = ['sending', 'otp', 'pending'];

  switch (transfer.status) {
    case 'success':
      updateTxIf(id, inFlight, { ...base, status: 'success', prompt: null, failure_reason: null });
      return;
    case 'reversed':
      updateTxIf(id, [...inFlight, 'success'], {
        ...base,
        status: 'reversed',
        prompt: null,
        failure_reason: 'The network could not deliver this transfer, so it was returned to your Paystack balance.',
      });
      return;
    case 'failed':
    case 'abandoned':
    case 'rejected':
    case 'blocked':
      updateTxIf(id, inFlight, { ...base, status: 'failed', prompt: null, failure_reason: describeFailure(transfer) });
      return;
    case 'otp':
      updateTxIf(id, inFlight, {
        ...base,
        status: 'otp',
        prompt: 'Enter the OTP Paystack sent to your business phone or email.',
      });
      return;
    default:
      // pending / received / queued / processing
      updateTxIf(id, inFlight, { ...base, status: 'pending', prompt: null });
  }
}

// --- One-time codes ----------------------------------------------------------------

export async function submitOtp(id: number, otp: string): Promise<TransactionView> {
  const code = String(otp ?? '').replace(/\s+/g, '');
  if (!/^\d{4,8}$/.test(code)) throw new UserError('Enter the numeric code you received.');

  const ran = await withLock(id, async () => {
    const tx = getTx(id);
    if (!tx) throw new UserError('Transfer not found.', 404);
    try {
      if (tx.status === 'funding_otp' && tx.charge_reference) {
        await applyCharge(id, await submitChargeOtp(code, tx.charge_reference));
      } else if (tx.status === 'otp' && tx.paystack_transfer_code) {
        applyTransfer(id, await finalizeTransfer(tx.paystack_transfer_code, code));
      } else {
        throw new UserError('This send is not waiting for a code.', 409);
      }
    } catch (err: any) {
      if (err instanceof PaystackApiError) throw new UserError(`Paystack did not accept that code: ${err.message}`);
      if (err instanceof UserError) throw err;
      throw new UserError('Could not reach Paystack. Try the code again.', 503);
    }
  });
  if (!ran) throw new UserError('Still working on this send. Try again in a moment.', 409);
  return toView(getTx(id)!);
}

// --- Reconciliation ---------------------------------------------------------------

function startedAt(tx: TxRow): number {
  return tx.confirmed_at ?? createdAtMs(tx);
}

/** Fresh transfers are checked every few seconds, older ones progressively less often. */
function isDue(tx: TxRow, now: number): boolean {
  const age = now - startedAt(tx);
  if (age > STOP_POLLING_AFTER_MS) return false;
  const gap = age < 2 * 60_000 ? 3_000 : age < 60 * 60_000 ? 60_000 : 15 * 60_000;
  return !tx.last_checked_at || now - tx.last_checked_at >= gap;
}

async function reconcile(id: number): Promise<void> {
  const tx = getTx(id);
  if (!tx || !ACTIVE_STATUSES.includes(tx.status)) return;
  const now = Date.now();

  if (tx.status === 'funding' || tx.status === 'funding_otp') {
    const charge = tx.charge_reference ? await checkPendingCharge(tx.charge_reference) : null;
    if (charge) await applyCharge(id, charge);

    const after = getTx(id)!;
    if (after.status === 'funding' || after.status === 'funding_otp') {
      if (!charge && now - (after.attempted_at ?? startedAt(after)) > UNKNOWN_OUTCOME_GRACE_MS) {
        fail(id, 'The wallet charge was never created at Paystack. Nothing was sent.');
      } else if (now - startedAt(after) > config.fundingTimeoutMs && charge?.status !== 'success') {
        fail(
          id,
          'The wallet charge was not approved in time, so nothing was sent. ' +
            'If you approve it later, the money will sit in your Paystack balance.'
        );
      }
    }
  } else {
    const transfer = tx.paystack_reference ? await verifyTransfer(tx.paystack_reference) : null;
    if (transfer) {
      applyTransfer(id, transfer);
    } else if (tx.status === 'sending' && now - (tx.attempted_at ?? startedAt(tx)) > UNKNOWN_OUTCOME_GRACE_MS) {
      fail(
        id,
        'The transfer was never created at Paystack, so no money was sent.' +
          (tx.charge_reference ? ' Your wallet top-up is in your Paystack balance.' : '')
      );
    }
  }

  getDb().prepare('UPDATE transactions SET last_checked_at = ? WHERE id = ?').run(Date.now(), id);
}

/** Check one transfer against Paystack right now (used by webhooks). */
export async function reconcileByReference(reference: string): Promise<boolean> {
  const tx = findTxByReference(reference);
  if (!tx) return false;
  // A success can still turn into a reversal, which only a webhook tells us about.
  if (tx.status === 'success' && tx.paystack_reference) {
    const transfer = await verifyTransfer(tx.paystack_reference);
    if (transfer) applyTransfer(tx.id, transfer);
    return true;
  }
  await withLock(tx.id, () => reconcile(tx.id));
  return true;
}

/** One pass over everything in flight. Errors are logged, never thrown. */
export async function reconcileActive(options: { force?: boolean } = {}): Promise<void> {
  expireStaleQuotes();
  const now = Date.now();
  for (const tx of listActiveTx()) {
    if (!options.force && !isDue(tx, now)) continue;
    try {
      await withLock(tx.id, () => reconcile(tx.id));
    } catch (err: any) {
      logger.warn('Reconcile of transfer %d failed: %s', tx.id, err?.message);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let passRunning = false;

export function startReconciler(): void {
  if (timer) return;
  timer = setInterval(async () => {
    if (passRunning) return;
    passRunning = true;
    try {
      await reconcileActive();
    } finally {
      passRunning = false;
    }
  }, config.reconcileIntervalMs);
  timer.unref();
}

export function stopReconciler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
