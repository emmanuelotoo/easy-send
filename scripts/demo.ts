/**
 * Run the whole app against the mock Paystack: `npm run demo`.
 * No real keys, no real money. Data lives in data/demo so it never mixes with yours.
 */
import { startMockPaystack } from './mock-paystack';

async function main() {
  const mock = await startMockPaystack({
    port: Number(process.env.MOCK_PORT) || 4010,
    balance: process.env.MOCK_BALANCE_GHS ? Math.round(Number(process.env.MOCK_BALANCE_GHS) * 100) : undefined,
  });
  // MOCK_TRANSFER_OTP=1 / MOCK_CHARGE_OTP=1 exercise the one-time-code screens (the code is 123456).
  mock.state.transferOtp = process.env.MOCK_TRANSFER_OTP === '1';
  mock.state.chargeOtp = process.env.MOCK_CHARGE_OTP === '1';

  process.env.PAYSTACK_BASE_URL = mock.url;
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_mock';
  process.env.OWNER_PHONE ||= '0241112223';
  process.env.OWNER_EMAIL ||= 'owner@example.com';
  process.env.SETUP_CODE ||= 'demo-setup-code';
  process.env.DATA_DIR ||= 'data/demo';

  console.log(`Mock Paystack listening at ${mock.url} (balance GHS ${(mock.state.balance / 100).toFixed(2)})`);
  console.log(`Setup code: ${process.env.SETUP_CODE}`);

  await import('../src/index');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
