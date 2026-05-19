# Easy-Send

Personal WhatsApp chatbot that sends MTN MoMo (Ghana) payments via natural-language commands. Single user, runs locally.

## How it works

You message your own WhatsApp number; the bot parses commands like `send 50 to Kojo` or `send 20 to 0241234567`, asks for confirmation, then dispatches the transfer via Paystack. Funds come from your MTN MoMo wallet (auto-charged when the Paystack balance is low).

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in:
   - `OWNER_WHATSAPP_JID` — your number as `233XXXXXXXXX@s.whatsapp.net`
   - `OWNER_PHONE`, `OWNER_EMAIL`
   - `PAYSTACK_SECRET_KEY` (start with `sk_test_…`)
3. `cp data/contacts.example.json data/contacts.json` and edit with real recipients
4. `npm run dev` — scan the QR with WhatsApp on first run

The session persists in `data/wa-auth/`, so the QR is one-time.

## Commands

| Message | Effect |
|---|---|
| `send 50 to Kojo` | Initiate transfer to saved contact |
| `send 20 to 0241234567` | Ad-hoc transfer to raw number |
| `yes` / `no` | Confirm or cancel pending transfer |
| `bal` | Paystack balance |
| `history` | Recent transactions |
| `contacts` | List saved contacts |
| `add contact <name> <phone>` | Save a new contact |
| `help` | Show help |

Amounts accept word-numbers (`fifty`) and optional currency words (`cedis`, `ghs`).

## Scripts

- `npm run dev` — run with tsx (no build step)
- `npm run build` — production build via tsup
- `npm start` — run the build
- `npx tsc --noEmit` — type-check

## Stack

Node.js + TypeScript · Baileys (WhatsApp) · Paystack (payments) · better-sqlite3 (local state)

## Notes

- Limits: per-transaction and daily caps configured in `.env`
- All amounts internally in pesewas (integer); 1 GHS = 100 pesewas
- `.env`, `data/contacts.json`, and `data/*.db` are gitignored — your secrets and contacts stay local
