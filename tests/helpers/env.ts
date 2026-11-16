/**
 * Import this FIRST in any test that touches the server: config reads the
 * environment when it is first loaded.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-send-test-'));

Object.assign(process.env, {
  DATA_DIR: dataDir,
  PUBLIC_DIR: path.join(dataDir, 'no-public'),
  APP_ORIGIN: 'http://localhost:3000',
  SETUP_CODE: 'test-setup-code-123',
  OWNER_PHONE: '0241112223',
  OWNER_EMAIL: 'owner@example.com',
  PAYSTACK_SECRET_KEY: 'sk_test_unit',
  PAYSTACK_BASE_URL: 'http://127.0.0.1:1',
  DAILY_LIMIT_GHS: '500',
  PER_TRANSACTION_LIMIT_GHS: '200',
  LOW_BALANCE_ALERT_GHS: '50',
  AUTO_FUND: 'true',
  LOG_LEVEL: 'silent',
});

process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));
