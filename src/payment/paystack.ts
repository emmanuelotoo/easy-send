import { config } from '../config';
import { logger } from '../utils/logger';
import { PaystackBalance, PaystackBank, PaystackRecipient, PaystackTransfer } from './types';
import crypto from 'crypto';

const BASE_URL = 'https://api.paystack.co';

async function paystackRequest<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>
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

/** Get available Paystack balance */
export async function getBalance(): Promise<PaystackBalance[]> {
  return paystackRequest<PaystackBalance[]>('GET', '/balance');
}

/** Get GHS balance in pesewas */
export async function getGHSBalance(): Promise<number> {
  const balances = await getBalance();
  const ghs = balances.find(b => b.currency === 'GHS');
  return ghs?.balance ?? 0;
}

/** List supported mobile money banks/providers */
export async function listMobileMoneyBanks(): Promise<PaystackBank[]> {
  return paystackRequest<PaystackBank[]>('GET', '/bank?currency=GHS&type=mobile_money');
}

/** Find the Telecel Cash provider code dynamically */
export async function resolveTelecelCode(): Promise<string | null> {
  const banks = await listMobileMoneyBanks();
  // Look for Telecel or Vodafone (Telecel was formerly Vodafone Ghana)
  const telecel = banks.find(
    b =>
      b.name.toLowerCase().includes('telecel') ||
      b.name.toLowerCase().includes('vodafone')
  );

  if (telecel) {
    logger.info('Resolved Telecel provider code: %s (%s)', telecel.code, telecel.name);
    return telecel.code;
  }

  logger.error('Could not find Telecel/Vodafone in Paystack banks: %o', banks.map(b => b.name));
  return null;
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

/** Verify a transfer status */
export async function verifyTransfer(reference: string): Promise<PaystackTransfer> {
  return paystackRequest<PaystackTransfer>('GET', `/transfer/verify/${reference}`);
}
