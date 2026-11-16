import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  PaystackAccountResolution,
  PaystackBalance,
  PaystackBank,
  PaystackCharge,
  PaystackRecipient,
  PaystackTransfer,
} from './types';
import { Network } from '../utils/phone';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Paystack answered and said no. The request definitely did not go through,
 * so it is safe to report the failure to the user.
 */
export class PaystackApiError extends Error {
  constructor(message: string, readonly httpStatus: number) {
    super(message);
    this.name = 'PaystackApiError';
  }
}

/**
 * We could not get a usable answer (timeout, dropped connection, 5xx).
 * The outcome is UNKNOWN: for a transfer, money may or may not have moved,
 * so callers must verify by reference instead of assuming failure.
 */
export class PaystackNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaystackNetworkError';
  }
}

async function paystackRequest<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.paystackBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.paystackSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    throw new PaystackNetworkError(`Could not reach Paystack (${err?.name ?? 'error'})`);
  }

  type Envelope = { status?: boolean; message?: string; data?: T };
  const json = (await res.json().catch(() => null)) as Envelope | null;

  if (res.status >= 500 || json === null || typeof json !== 'object') {
    throw new PaystackNetworkError(`Paystack is unavailable (HTTP ${res.status})`);
  }
  if (!res.ok || !json.status) {
    throw new PaystackApiError(json.message || `Paystack rejected the request (HTTP ${res.status})`, res.status);
  }
  return json.data as T;
}

/** Unique reference for a transfer or charge. Doubles as Paystack's idempotency key. */
export function generateReference(): string {
  return `easysend_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

/** GHS balance available for transfers, in pesewas. */
export async function getGHSBalance(): Promise<number> {
  const balances = await paystackRequest<PaystackBalance[]>('GET', '/balance', undefined, 15_000);
  const ghs = balances.find(b => b.currency === 'GHS');
  return ghs?.balance ?? 0;
}

/** Name fragments that identify each network in Paystack's bank list. */
const NETWORK_BANK_ALIASES: Record<Network, string[]> = {
  mtn: ['mtn'],
  telecel: ['telecel', 'vodafone'],
  airteltigo: ['airteltigo', 'airtel', 'tigo'],
};

/** Resolve every Ghana mobile-money network's Paystack bank code. */
export async function resolveMomoBankCodes(): Promise<Record<Network, string | null>> {
  const banks = await paystackRequest<PaystackBank[]>('GET', '/bank?currency=GHS&type=mobile_money');
  const result: Record<Network, string | null> = { mtn: null, telecel: null, airteltigo: null };

  for (const network of Object.keys(NETWORK_BANK_ALIASES) as Network[]) {
    const aliases = NETWORK_BANK_ALIASES[network];
    const match = banks.find(b => aliases.some(a => b.name.toLowerCase().includes(a)));
    if (match) {
      result[network] = match.code;
      logger.info('Resolved %s provider code: %s (%s)', network, match.code, match.name);
    } else {
      logger.warn('Could not find %s in Paystack mobile money banks', network);
    }
  }

  return result;
}

/** Create a transfer recipient. */
export async function createRecipient(
  name: string,
  phone: string,
  bankCode: string
): Promise<PaystackRecipient> {
  return paystackRequest<PaystackRecipient>('POST', '/transferrecipient', {
    type: 'mobile_money',
    name,
    account_number: phone,
    bank_code: bankCode,
    currency: 'GHS',
  });
}

/** Initiate a transfer from the Paystack balance to a recipient. */
export async function initiateTransfer(
  recipientCode: string,
  amountPesewas: number,
  reason: string,
  reference: string
): Promise<PaystackTransfer> {
  return paystackRequest<PaystackTransfer>('POST', '/transfer', {
    source: 'balance',
    amount: amountPesewas,
    recipient: recipientCode,
    reason,
    reference,
  });
}

/** Look a transfer up by our reference. Returns null when Paystack has no such transfer. */
export async function verifyTransfer(reference: string): Promise<PaystackTransfer | null> {
  try {
    return await paystackRequest<PaystackTransfer>(
      'GET',
      `/transfer/verify/${encodeURIComponent(reference)}`
    );
  } catch (err) {
    if (err instanceof PaystackApiError && (err.httpStatus === 404 || err.httpStatus === 400)) {
      return null;
    }
    throw err;
  }
}

/** Complete a transfer that Paystack parked behind an OTP. */
export async function finalizeTransfer(transferCode: string, otp: string): Promise<PaystackTransfer> {
  return paystackRequest<PaystackTransfer>('POST', '/transfer/finalize_transfer', {
    transfer_code: transferCode,
    otp,
  });
}

/** Paystack's provider codes for charging a Ghana mobile money wallet. */
const CHARGE_PROVIDER: Record<Network, string> = {
  mtn: 'mtn',
  telecel: 'vod',
  airteltigo: 'atl',
};

/** Charge a mobile money wallet. The owner approves it on their phone. */
export async function chargeMobileMoney(
  amountPesewas: number,
  phone: string,
  network: Network,
  email: string,
  reference: string
): Promise<PaystackCharge> {
  return paystackRequest<PaystackCharge>('POST', '/charge', {
    amount: amountPesewas,
    email,
    currency: 'GHS',
    reference,
    mobile_money: {
      phone,
      provider: CHARGE_PROVIDER[network],
    },
  });
}

/** Submit the OTP Paystack asked for while charging a wallet. */
export async function submitChargeOtp(otp: string, reference: string): Promise<PaystackCharge> {
  return paystackRequest<PaystackCharge>('POST', '/charge/submit_otp', { otp, reference });
}

/** Current state of a wallet charge. Returns null when Paystack has no such charge. */
export async function checkPendingCharge(reference: string): Promise<PaystackCharge | null> {
  try {
    return await paystackRequest<PaystackCharge>('GET', `/charge/${encodeURIComponent(reference)}`);
  } catch (err) {
    if (err instanceof PaystackApiError && (err.httpStatus === 404 || err.httpStatus === 400)) {
      return null;
    }
    throw err;
  }
}

/**
 * Look up the registered account name for a mobile money number.
 * Returns null on any failure (unregistered number, network error, timeout):
 * callers treat null as "name unavailable" and warn rather than block.
 */
export async function resolveAccountName(phone: string, bankCode: string): Promise<string | null> {
  try {
    const data = await paystackRequest<PaystackAccountResolution>(
      'GET',
      `/bank/resolve?account_number=${encodeURIComponent(phone)}&bank_code=${encodeURIComponent(bankCode)}`,
      undefined,
      8000
    );
    return data.account_name || null;
  } catch (err: any) {
    logger.warn('Account name resolution failed: %s', err?.message);
    return null;
  }
}

/** Paystack signs webhook bodies with HMAC-SHA512 keyed by the secret key. */
export function isValidWebhookSignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha512', config.paystackSecretKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
