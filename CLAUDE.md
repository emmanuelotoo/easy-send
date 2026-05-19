# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Easy-Send is a personal WhatsApp chatbot that sends MTN MoMo (Ghana mobile money) payments via natural language commands. Single-user, runs locally. Built with Node.js + TypeScript.

## Commands

- `npm run dev` — Run in development mode (tsx, no compile step)
- `npm run build` — Production build (tsup)
- `npm start` — Run production build
- `npx tsc --noEmit` — Type-check without emitting

No test framework is set up yet.

## Architecture

The message flow is: **WhatsApp → Parser → Conversation State Machine → Payment Service → WhatsApp reply**.

### Boot sequence (`src/index.ts`)
1. Validate `.env` config
2. Run SQLite migrations from `src/db/migrations/`
3. Seed contacts from `data/contacts.json` (INSERT OR IGNORE)
4. Resolve MTN's Paystack bank code via `GET /bank?currency=GHS&type=mobile_money`
5. Start WhatsApp connection via Baileys (QR-pair on first run; session at `data/wa-auth/`)

### Message handling pipeline
- `whatsapp/connection.ts` — Baileys socket, QR pairing, auto-reconnect, message subscription
- `whatsapp/sender.ts` — `sendText(sock, jid, text)` for outbound messages
- `whatsapp/handler.ts` — Entry point for all incoming messages. Applies **owner-only guard** (compares `msg.key.remoteJid` to `OWNER_WHATSAPP_JID`), ignores groups/status/self, routes parsed commands to flow handlers

### Command parsing (`parser/regex.ts` + `parser/words.ts`)
Regex-based extraction with a word-number resolver. Returns a `ParsedCommand` with type, amount, recipient (nickname) or recipientPhone (raw Ghana number). Send patterns are flexible: word-numbers ("fifty"), optional "to", optional currency word ("cedis", "cediss", "cds", "ghs"), raw phone numbers (`02XXXXXXXXX` / `+233...`). Also supports: `bal`, `history`, `contacts`, `add contact <name> <phone>`, `help`, `yes/no`.

### Conversation state (`conversation/state.ts`)
In-memory state machine (single user, no persistence needed). Two states: `IDLE`, `AWAITING_CONFIRMATION`. Pending transfers auto-cancel after 2 minutes. A non-yes/no message while awaiting confirmation cancels the pending transfer and processes the new command.

### Payment flow (`conversation/flows.ts` + `payment/paystack.ts`)
This is the critical financial path:
1. Resolve recipient: contact nickname → DB row, OR raw phone → synthetic ad-hoc recipient (no DB row)
2. Validate amount against per-tx and daily limits (`payment/validator.ts`)
3. **Write transaction to SQLite with unique reference BEFORE calling Paystack** (idempotency). Ad-hoc sends use `contact_id = NULL`.
4. Ask for confirmation → wait for YES/NO
5. On YES: check Paystack balance. If insufficient, charge owner's MTN MoMo wallet via Paystack Charge API. User approves the PIN prompt on their phone; the bot polls charge status every 5s for up to 90s.
6. Create Paystack recipient (cache `recipient_code` on the contact row for saved contacts; one-off for ad-hoc), call `POST /transfer`, update transaction status
7. MTN bank code is cached in a module-level variable after startup resolution

### Key domain rules
- **All Paystack amounts are in pesewas** (1 GHS = 100 pesewas). Use `toPesewas()` / `formatGHS()` from `utils/money.ts`. Internal storage is always integer pesewas.
- **Phone numbers** exist in multiple formats: `0241234567` (local), `233241234567` (international). Normalize via `utils/phone.ts`.
- **MTN MoMo provider code** is `"mtn"` for Paystack Charge API; bank code is resolved dynamically from `/bank` at boot.
- Contact nicknames are case-insensitive (SQLite `COLLATE NOCASE`).
- Ad-hoc number transfers (e.g. paying an Uber driver) skip the saved-contacts table entirely.

## Database

SQLite via `better-sqlite3` at `data/easy-send.db` (gitignored). WAL mode enabled. Migrations tracked in a `migrations` table. Schema has two active tables: `contacts` and `transactions`. The `transactions.contact_id` column is nullable to support ad-hoc raw-phone sends.

## Configuration

All config via `.env` (see `.env.example`). Required: `OWNER_WHATSAPP_JID`, `OWNER_PHONE`, `OWNER_EMAIL`, `PAYSTACK_SECRET_KEY`. The app validates these at startup and fails fast.

## Gitignored state

- `data/*.db` — SQLite database
- `data/wa-auth/` — Baileys WhatsApp session
- `.env` — Secrets
