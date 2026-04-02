import { config } from '../config';
import { toPesewas } from '../utils/money';
import { getDb } from '../db/client';

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/** Validate a transfer amount against limits */
export function validateAmount(amountGHS: number): ValidationResult {
  if (amountGHS <= 0) {
    return { ok: false, error: 'Amount must be greater than zero.' };
  }

  if (amountGHS > config.perTransactionLimitGHS) {
    return {
      ok: false,
      error: `Amount exceeds per-transaction limit of GHS ${config.perTransactionLimitGHS}.`,
    };
  }

  // Check daily spending
  const todaySpent = getTodaySpendingPesewas();
  const newTotal = todaySpent + toPesewas(amountGHS);
  const dailyLimitPesewas = toPesewas(config.dailyLimitGHS);

  if (newTotal > dailyLimitPesewas) {
    const remaining = (dailyLimitPesewas - todaySpent) / 100;
    return {
      ok: false,
      error: `Daily limit of GHS ${config.dailyLimitGHS} would be exceeded. Remaining today: GHS ${remaining.toFixed(2)}.`,
    };
  }

  return { ok: true };
}

/** Get total amount sent today in pesewas */
function getTodaySpendingPesewas(): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_pesewas), 0) as total
       FROM transactions
       WHERE status = 'success'
         AND date(created_at) = date('now')`
    )
    .get() as { total: number };
  return row.total;
}
