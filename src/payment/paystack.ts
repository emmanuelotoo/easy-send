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
import crypto from 'crypto';

const BASE_URL = 'https://api.paystack.co';

async function paystackRequest<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${config.paystackSecretKey}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  if (signal) {
    options.signal = signal;
  }

  const res = await fetch(url, options);
  const json = await res.json() as { status: boolean; message: string; data: T };

  if (!json.status) {
    throw new Error(`Paystack error: ${json.message}`);
  }

  return json.data;
}

/** Generate a unique idempotency reference */
export function generateReference(): string {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `easysend_${timestamp}_${random}`;
}

/** Get GHS balance in pesewas */
export async function getGHSBalance(): Promise<number> {
  const balances = await paystackRequest<PaystackBalance[]>('GET', '/balance');
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

/** Create a transfer recipient (one-time per contact) */
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

/** Initiate a transfer from Paystack balance to a recipient */
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

/** Charge an MTN MoMo wallet (provider "mtn"). User approves via PIN push on their phone. */
export async function chargeMobileMoney(
  amountPesewas: number,
  phone: string,
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
      provider: 'mtn',
    },
  });
}

/** Check the status of a pending charge (used while polling auto-fund). */
export async function checkPendingCharge(reference: string): Promise<PaystackCharge> {
  return paystackRequest<PaystackCharge>('GET', `/charge/${reference}`);
}

/**
 * Look up the registered account name for a mobile money number.
 * Returns null on any failure (unregistered number, network error, timeout) —
 * callers treat a null as "name unavailable" and warn rather than block.
 */
export async function resolveAccountName(phone: string, bankCode: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const data = await paystackRequest<PaystackAccountResolution>(
      'GET',
      `/bank/resolve?account_number=${encodeURIComponent(phone)}&bank_code=${encodeURIComponent(bankCode)}`,
      undefined,
      controller.signal
    );
    return data.account_name;
  } catch (err) {
    logger.warn({ err }, 'Account name resolution failed');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
