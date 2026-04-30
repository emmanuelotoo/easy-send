/**
 * Normalize a Ghana phone number to different formats.
 *
 * Input examples: "0241234567", "+233241234567", "233241234567"
 * All refer to the same number.
 */

/** Strip to digits only, then normalize to 233XXXXXXXXX */
export function toInternational(phone: string): string {
  const digits = phone.replace(/\D/g, '');

  if (digits.startsWith('0') && digits.length === 10) {
    return '233' + digits.slice(1);
  }
  if (digits.startsWith('233') && digits.length === 12) {
    return digits;
  }
  // Already in correct format or unknown — return as-is
  return digits;
}

/** Format for local display: 0XX XXX XXXX */
export function toLocal(phone: string): string {
  const intl = toInternational(phone);
  const local = '0' + intl.slice(3);
  return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
}

