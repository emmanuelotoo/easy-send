import 'dotenv/config';

export const config = {
  ownerWhatsappJid: process.env.OWNER_WHATSAPP_JID || '',
  whatsappAuthDir: process.env.WHATSAPP_AUTH_DIR || 'data/wa-auth',
  ownerPhone: process.env.OWNER_PHONE || '',
  ownerEmail: process.env.OWNER_EMAIL || '',
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || '',
  dailyLimitGHS: Number(process.env.DAILY_LIMIT_GHS) || 500,
  perTransactionLimitGHS: Number(process.env.PER_TRANSACTION_LIMIT_GHS) || 200,
  lowBalanceAlertGHS: Number(process.env.LOW_BALANCE_ALERT_GHS) || 50,
  logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
  confirmationTimeoutMs: 2 * 60 * 1000,
};

export function validateConfig(): void {
  if (!config.ownerWhatsappJid) {
    throw new Error('OWNER_WHATSAPP_JID is required in .env (e.g. 233241234567@s.whatsapp.net)');
  }
  if (!config.ownerPhone) {
    throw new Error('OWNER_PHONE is required in .env');
  }
  if (!config.ownerEmail) {
    throw new Error('OWNER_EMAIL is required in .env');
  }
  if (!config.paystackSecretKey) {
    throw new Error('PAYSTACK_SECRET_KEY is required in .env');
  }
}
