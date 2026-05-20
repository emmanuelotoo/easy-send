/** Paystack Ghana pricing — kept in one place. */

/** Flat fee Paystack charges per Mobile Money transfer, in pesewas (GHS 1). */
export const TRANSFER_FEE_PESEWAS = 100;

/** Paystack's local-transaction (collection) fee rate — 1.95%. */
export const CHARGE_FEE_RATE = 0.0195;

/** Buffer added to an auto-fund charge so rounding or minor fee drift cannot
 *  cause a re-failure, in pesewas (GHS 0.50). */
export const FUND_MARGIN_PESEWAS = 50;

/**
 * Amount to charge the owner's wallet to cover a transfer shortfall.
 * Grosses up for Paystack's 1.95% collection cut and the GHS 1 transfer fee,
 * then adds a margin. Biased high on purpose: a surplus just stays in the
 * Paystack balance, while undercharging breaks the transfer.
 */
export function computeChargeAmount(deficitPesewas: number): number {
  return (
    Math.ceil((deficitPesewas + TRANSFER_FEE_PESEWAS) / (1 - CHARGE_FEE_RATE)) +
    FUND_MARGIN_PESEWAS
  );
}
