import { getDb } from '../db/client';
import { Network, networkLabel, toLocal } from '../utils/phone';

export type TxStatus =
  | 'quoted'      // priced and waiting for the owner to confirm
  | 'cancelled'
  | 'expired'
  | 'funding'     // wallet charge started, waiting for approval on the phone
  | 'funding_otp' // wallet charge needs a code from the owner
  | 'sending'     // confirmed; transfer being created (or its outcome is not yet known)
  | 'otp'         // Paystack wants a transfer OTP
  | 'pending'     // Paystack accepted the transfer; the network is delivering it
  | 'success'
  | 'failed'
  | 'reversed';

export const FINAL_STATUSES: TxStatus[] = ['cancelled', 'expired', 'success', 'failed', 'reversed'];
/** Statuses the reconciler keeps checking against Paystack. */
export const ACTIVE_STATUSES: TxStatus[] = ['funding', 'funding_otp', 'sending', 'otp', 'pending'];

export interface TxRow {
  id: number;
  contact_id: number | null;
  amount_pesewas: number;
  status: TxStatus;
  paystack_reference: string | null;
  paystack_transfer_code: string | null;
  reason: string | null;
  created_at: string;
  charge_reference: string | null;
  phone: string | null;
  network: Network | null;
  recipient_name: string | null;
  verified_name: string | null;
  fee_pesewas: number;
  charge_amount_pesewas: number | null;
  failure_reason: string | null;
  prompt: string | null;
  attempted_at: number | null;
  challenge: string | null;
  expires_at: number | null;
  confirmed_at: number | null;
  last_checked_at: number | null;
}

/** What the app is allowed to see. Never includes challenges or Paystack codes. */
export interface TransactionView {
  id: number;
  status: TxStatus;
  amountPesewas: number;
  feePesewas: number;
  chargeAmountPesewas: number | null;
  recipientName: string;
  verifiedName: string | null;
  phone: string | null;
  network: Network | null;
  networkLabel: string | null;
  contactId: number | null;
  reference: string | null;
  failureReason: string | null;
  prompt: string | null;
  createdAt: string;
  expiresAt: number | null;
}

/** SQLite's datetime('now') is UTC without a zone marker. */
export function createdAtMs(row: Pick<TxRow, 'created_at'>): number {
  return Date.parse(row.created_at.replace(' ', 'T') + 'Z');
}

export function toView(row: TxRow): TransactionView {
  return {
    id: row.id,
    status: row.status,
    amountPesewas: row.amount_pesewas,
    feePesewas: row.fee_pesewas,
    chargeAmountPesewas: row.charge_amount_pesewas,
    recipientName: row.recipient_name ?? 'Mobile number',
    verifiedName: row.verified_name,
    phone: row.phone ? toLocal(row.phone) : null,
    network: row.network,
    networkLabel: row.network ? networkLabel(row.network) : null,
    contactId: row.contact_id,
    reference: row.paystack_reference,
    failureReason: row.failure_reason,
    prompt: row.prompt,
    createdAt: new Date(createdAtMs(row)).toISOString(),
    expiresAt: row.status === 'quoted' ? row.expires_at : null,
  };
}

export function getTx(id: number): TxRow | undefined {
  return getDb().prepare('SELECT * FROM transactions WHERE id = ?').get(id) as TxRow | undefined;
}

export function findTxByReference(reference: string): TxRow | undefined {
  return getDb()
    .prepare('SELECT * FROM transactions WHERE paystack_reference = ? OR charge_reference = ?')
    .get(reference, reference) as TxRow | undefined;
}

/** History: real sends only. Quotes that were never confirmed are noise. */
export function listTx(limit: number): TxRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM transactions
        WHERE status NOT IN ('quoted', 'cancelled', 'expired')
        ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as TxRow[];
}

export function listActiveTx(): TxRow[] {
  return getDb()
    .prepare(`SELECT * FROM transactions WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`)
    .all(...ACTIVE_STATUSES) as TxRow[];
}

const KEEP_DEAD_QUOTES_MS = 24 * 60 * 60 * 1000;

export function expireStaleQuotes(now = Date.now()): void {
  const db = getDb();
  db.prepare("UPDATE transactions SET status = 'expired', challenge = NULL WHERE status = 'quoted' AND expires_at < ?").run(
    now
  );
  // Quotes that were never confirmed moved no money; drop them after a day.
  db.prepare(
    "DELETE FROM transactions WHERE status IN ('expired', 'cancelled') AND confirmed_at IS NULL AND expires_at < ?"
  ).run(now - KEEP_DEAD_QUOTES_MS);
}

/** Set columns on a row, but only while it is still in one of the given statuses. */
export function updateTxIf(id: number, from: TxStatus[], changes: Partial<TxRow>): boolean {
  const cols = Object.keys(changes) as Array<keyof TxRow>;
  const sql =
    `UPDATE transactions SET ${cols.map(c => `${c} = ?`).join(', ')} ` +
    `WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`;
  const info = getDb().prepare(sql).run(...cols.map(c => changes[c] as any), id, ...from);
  return info.changes === 1;
}
