-- Web app: transfers become a persisted state machine instead of in-memory chat state.
-- Status values: quoted, cancelled, expired, funding, funding_otp, sending, otp,
--                pending, success, failed, reversed

ALTER TABLE transactions ADD COLUMN phone TEXT;
ALTER TABLE transactions ADD COLUMN network TEXT;
ALTER TABLE transactions ADD COLUMN recipient_name TEXT;
ALTER TABLE transactions ADD COLUMN verified_name TEXT;
ALTER TABLE transactions ADD COLUMN fee_pesewas INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN charge_amount_pesewas INTEGER;
ALTER TABLE transactions ADD COLUMN failure_reason TEXT;
ALTER TABLE transactions ADD COLUMN prompt TEXT;
ALTER TABLE transactions ADD COLUMN attempted_at INTEGER;
ALTER TABLE transactions ADD COLUMN challenge TEXT;
ALTER TABLE transactions ADD COLUMN expires_at INTEGER;
ALTER TABLE transactions ADD COLUMN confirmed_at INTEGER;
ALTER TABLE transactions ADD COLUMN last_checked_at INTEGER;

-- Rows written by the WhatsApp bot: keep them readable in history.
UPDATE transactions
   SET recipient_name = (SELECT nickname FROM contacts WHERE contacts.id = transactions.contact_id),
       phone          = (SELECT phone    FROM contacts WHERE contacts.id = transactions.contact_id)
 WHERE contact_id IS NOT NULL;
UPDATE transactions SET recipient_name = 'Mobile number' WHERE recipient_name IS NULL;
UPDATE transactions SET fee_pesewas = 100 WHERE paystack_transfer_code IS NOT NULL;

-- The bot stored unconfirmed sends as 'pending'; without a transfer code no money moved.
UPDATE transactions SET status = 'cancelled'
 WHERE status = 'pending' AND paystack_transfer_code IS NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,              -- credential id (base64url)
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                  -- JSON array
  label TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,      -- sha256 of the cookie value
  expires_at INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Short-lived WebAuthn challenges for sign-in and enrollment.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,            -- 'register' | 'login'
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
