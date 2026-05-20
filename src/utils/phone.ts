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

/** Ghana mobile money networks supported for transfers. */
export type Network = 'mtn' | 'telecel' | 'airteltigo';

/** Local 3-digit prefix → network. */
const NETWORK_PREFIXES: Record<string, Network> = {
  '024': 'mtn',
  '025': 'mtn',
  '053': 'mtn',
  '054': 'mtn',
  '055': 'mtn',
  '059': 'mtn',
  '020': 'telecel',
  '050': 'telecel',
  '026': 'airteltigo',
  '027': 'airteltigo',
  '056': 'airteltigo',
  '057': 'airteltigo',
};

/**
 * Detect the mobile network from a Ghana phone number.
 * Returns null for an unrecognized or malformed number.
 */
export function detectNetwork(phone: string): Network | null {
  const intl = toInternational(phone);
  if (!intl.startsWith('233') || intl.length !== 12) return null;
  const prefix = '0' + intl.slice(3, 5);
  return NETWORK_PREFIXES[prefix] ?? null;
}

const NETWORK_LABELS: Record<Network, string> = {
  mtn: 'MTN',
  telecel: 'Telecel',
  airteltigo: 'AirtelTigo',
};

/** Human-readable network name for display in messages. */
export function networkLabel(network: Network): string {
  return NETWORK_LABELS[network];
}
