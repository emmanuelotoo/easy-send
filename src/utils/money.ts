/**
 * Convert GHS (cedis) to pesewas for Paystack API.
 * Uses integer arithmetic to avoid floating point errors.
 */
export function toPesewas(ghs: number): number {
  return Math.round(ghs * 100);
}

/**
 * Convert pesewas to GHS string for display.
 */
export function toGHS(pesewas: number): string {
  return (pesewas / 100).toFixed(2);
}

/**
 * Format amount for user display: "GHS 50.00"
 */
export function formatGHS(pesewas: number): string {
  return `GHS ${toGHS(pesewas)}`;
}
