import 'dotenv/config';
import path from 'path';

const port = Number(process.env.PORT) || 3000;
const appOrigin = (process.env.APP_ORIGIN || `http://localhost:${port}`).replace(/\/+$/, '');

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

export const config = {
  port,
  host: process.env.HOST || '0.0.0.0',
  /** Public origin the PWA is served from. Passkeys are bound to its hostname. */
  appOrigin,
  /** One-time code that authorises enrolling a passkey. Unset it to lock enrollment. */
  setupCode: process.env.SETUP_CODE || '',
  dataDir: path.resolve(process.env.DATA_DIR || 'data'),
  publicDir: path.resolve(process.env.PUBLIC_DIR || 'public'),

  ownerPhone: process.env.OWNER_PHONE || '',
  ownerEmail: process.env.OWNER_EMAIL || '',
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || '',
  paystackBaseUrl: (process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co').replace(/\/+$/, ''),
  /** Charge the owner's MoMo wallet when the Paystack balance can't cover a send. */
  autoFund: flag(process.env.AUTO_FUND, true),

  dailyLimitGHS: Number(process.env.DAILY_LIMIT_GHS) || 500,
  perTransactionLimitGHS: Number(process.env.PER_TRANSACTION_LIMIT_GHS) || 200,
  lowBalanceAlertGHS: Number(process.env.LOW_BALANCE_ALERT_GHS) || 50,
  logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error' | 'silent',

  /** How long a quote stays confirmable. */
  quoteTtlMs: 5 * 60 * 1000,
  /** How long to wait for a wallet charge to be approved before giving up. */
  fundingTimeoutMs: 4 * 60 * 1000,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS) || 5000,
};

export const rpId = new URL(config.appOrigin).hostname;
export const isSecureOrigin = config.appOrigin.startsWith('https://');

export function validateConfig(): void {
  const missing: string[] = [];
  if (!config.ownerPhone) missing.push('OWNER_PHONE');
  if (!config.ownerEmail) missing.push('OWNER_EMAIL');
  if (!config.paystackSecretKey) missing.push('PAYSTACK_SECRET_KEY');
  if (missing.length) {
    throw new Error(`Missing required settings in .env: ${missing.join(', ')}`);
  }
  if (config.setupCode && config.setupCode.length < 12) {
    throw new Error('SETUP_CODE must be at least 12 characters (try: openssl rand -hex 16)');
  }
}
