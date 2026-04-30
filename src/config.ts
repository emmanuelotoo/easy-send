import 'dotenv/config';

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  ownerTelegramId: Number(process.env.OWNER_TELEGRAM_ID) || 0,
  ownerPhone: process.env.OWNER_PHONE || '',
  ownerEmail: process.env.OWNER_EMAIL || '',
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || '',
  dailyLimitGHS: Number(process.env.DAILY_LIMIT_GHS) || 500,
  perTransactionLimitGHS: Number(process.env.PER_TRANSACTION_LIMIT_GHS) || 200,
  lowBalanceAlertGHS: Number(process.env.LOW_BALANCE_ALERT_GHS) || 50,
  defaultScheduleTime: process.env.DEFAULT_SCHEDULE_TIME || '09:00',
  logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
  confirmationTimeoutMs: 2 * 60 * 1000, // 2 minutes
};

// Validate required config at startup
export function validateConfig(): void {
  if (!config.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required in .env');
  }
  if (!config.ownerTelegramId) {
    throw new Error('OWNER_TELEGRAM_ID is required in .env');
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
