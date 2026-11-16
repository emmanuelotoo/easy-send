import { config } from '../config';
import { toPesewas, formatGHS } from '../utils/money';
import { getDb } from '../db/client';

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/** Statuses where no money left (or will leave) the balance. */
const NOT_SPENT = ['quoted', 'cancelled', 'expired', 'failed', 'reversed'];

/**
 * Total committed today in pesewas (UTC day, which is Ghana's local day).
 * Counts every confirmed send that hasn't definitively failed, because an
 * in-flight transfer has already left the balance.
 */
export function getTodaySpendingPesewas(excludeTransactionId?: number): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_pesewas), 0) AS total
         FROM transactions
        WHERE status NOT IN (${NOT_SPENT.map(() => '?').join(',')})
          AND date(created_at) = date('now')
          AND id != ?`
    )
    .get(...NOT_SPENT, excludeTransactionId ?? -1) as { total: number };
  return row.total;
}

/** Validate a transfer amount against the configured limits. */
export function validateAmount(amountPesewas: number, excludeTransactionId?: number): ValidationResult {
  if (!Number.isSafeInteger(amountPesewas) || amountPesewas <= 0) {
    return { ok: false, error: 'Enter an amount greater than zero.' };
  }

  const perTx = toPesewas(config.perTransactionLimitGHS);
  if (amountPesewas > perTx) {
    return { ok: false, error: `That is over your per-send limit of ${formatGHS(perTx)}.` };
  }

  const daily = toPesewas(config.dailyLimitGHS);
  const spent = getTodaySpendingPesewas(excludeTransactionId);
  if (spent + amountPesewas > daily) {
    const remaining = Math.max(0, daily - spent);
    return {
      ok: false,
      error: `That would pass your daily limit of ${formatGHS(daily)}. You can still send ${formatGHS(remaining)} today.`,
    };
  }

  return { ok: true };
}
