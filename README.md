# Easy-Send

A personal, installable web app (PWA) for sending Ghana mobile money (MTN, Telecel, AirtelTigo) in two taps. Single user, built on Paystack.

Tap a contact, type an amount, check the recipient's registered name, and approve with your fingerprint. Or type `send 50 to Kojo` in the command bar.

## How it works

1. **Quote.** You pick a contact (or enter any number) and an amount. The server checks your limits, detects the network, asks Paystack for the name registered to that number, and shows the full cost.
2. **Confirm.** Every send is approved with a passkey (fingerprint, face or screen lock). The approval is bound to that one quote, so it cannot be replayed for another transfer.
3. **Send.** The transfer is paid from your Paystack balance. If the balance is short, the app can pull the shortfall from your own MoMo wallet first (optional, see Costs).
4. **Track.** The receipt screen updates live until Paystack reports the final result. Failures and reversals are shown with the reason.

## Try it without real money

```bash
npm install
npm run demo
```

Open http://localhost:3000 and pair with the setup code `demo-setup-code`. This runs against a built-in mock of Paystack, with its own database in `data/demo`.

Useful demo switches:

| Variable | Effect |
|---|---|
| `MOCK_BALANCE_GHS=5` | Start with a low balance to see the wallet top-up flow |
| `MOCK_TRANSFER_OTP=1` | Transfers ask for a Paystack OTP (the code is `123456`) |
| `MOCK_CHARGE_OTP=1` | Wallet top-ups ask for an OTP (the code is `123456`) |

Numbers ending in `9999` fail after being accepted, and numbers ending in `0000` cannot be name-verified.

## Real setup

1. `npm install`
2. `cp .env.example .env` and fill it in. At minimum: `APP_ORIGIN`, `SETUP_CODE`, `PAYSTACK_SECRET_KEY`, `OWNER_PHONE`, `OWNER_EMAIL`.
3. `npm run dev` for local work, or `npm run build && npm start` for production.
4. Open the app, enter your `SETUP_CODE`, and create a passkey. Repeat on any other device you want to use.
5. On your phone, use the browser's "Add to Home Screen" or "Install app".

### It must be served over HTTPS

Passkeys and installable apps only work on `https://` (or `http://localhost` for development). Any host that gives you HTTPS and a persistent disk works. `APP_ORIGIN` must match the address exactly, because passkeys are tied to that hostname. If the hostname changes, devices must be paired again.

A `Dockerfile` is included. Mount a persistent volume at `/data`: it holds the SQLite database, including your passkeys.

```bash
docker build -t easy-send .
docker run -p 3000:3000 -v easy-send-data:/data --env-file .env easy-send
```

### Paystack checklist

- **Registered business.** Paystack only allows transfers and balance top-ups for registered businesses in Ghana. A Starter account cannot send.
- **Fund your balance.** Top up from the Paystack dashboard (free in Ghana) and keep a float.
- **Webhook (recommended).** Set your webhook URL to `https://<your-host>/api/webhooks/paystack` so results arrive instantly. Without it the app still polls Paystack for every in-flight transfer.
- **Transfer OTP.** If Paystack's transfer OTP is on, the app asks you for the code on the receipt screen. You can also turn it off in the Paystack dashboard.
- **Manual payouts (only for auto-fund).** Money charged from your wallet is only spendable for transfers if your account holds collections in the Paystack balance instead of settling them to your bank. Without that, set `AUTO_FUND=false`.

Start with a `sk_test_...` key, then make one small live send before relying on it.

## Security model

- **Passkeys only.** No passwords. A session cookie unlocks viewing; moving money always needs a fresh passkey check with user verification.
- **Setup code.** `SETUP_CODE` authorises pairing a device. It is as powerful as a passkey, so make it long and random. Remove it from `.env` after pairing to lock enrollment (the app keeps working; add it back to pair another device).
- **Limits.** Per-send and daily caps from `.env` are enforced on the server at quote time and again at confirmation.
- **No double sends.** Each transfer has one Paystack reference and is created at most once. If Paystack times out, the app looks the transfer up by reference instead of retrying.
- **Webhooks** must carry a valid Paystack signature, and even then they only trigger a lookup at Paystack.
- The Paystack secret key lives only on the server. The browser never sees it.

## Commands in the app

The command bar on the home screen understands:

| You type | Effect |
|---|---|
| `send 50 to Kojo` | Opens a send to a saved contact |
| `send fifty cedis to 0241234567` | Opens a send to any number |
| `add contact Ama 0551234567` | Saves a contact |
| `history`, `contacts`, `bal` | Jump to that screen |

## Scripts

- `npm run demo`: the app against the mock Paystack
- `npm run dev`: run with auto-reload (needs `.env`)
- `npm run build` / `npm start`: production build and run
- `npm test`: unit and API tests (uses the mock Paystack and a software passkey)
- `npm run typecheck`

## Costs

- Paystack charges a flat **GHS 1 per mobile money transfer**.
- Auto-funding from your wallet costs an extra **1.95%** (Paystack's collection fee). The review screen shows the exact extra cost before you confirm.
- Cheapest way to run it: keep a float in your Paystack balance using the dashboard's free top-up.

## Stack

Node.js + TypeScript, Fastify, better-sqlite3, SimpleWebAuthn on the server. The frontend is plain JavaScript modules with no build step, plus a service worker and web app manifest.

```
src/
  auth/        passkeys and sessions
  contacts/    contact storage
  db/          SQLite client and migrations
  http/        API routes and static hosting
  parser/      "send 50 to Kojo" command parsing
  payment/     Paystack client, fees, limits
  transfers/   the transfer state machine and reconciler
public/        the PWA
scripts/       mock Paystack and the demo runner
tests/
```

## Notes

- All amounts are stored in pesewas (integers).
- `.env` and everything in `data/` except the example contacts file are gitignored.
- A `data/contacts.json` file (same shape as `data/contacts.example.json`) is imported on startup if present.
- Upgrading from the WhatsApp bot version keeps your contacts and history. The database is migrated on first start.
