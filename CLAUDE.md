# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Easy-Send is a personal WhatsApp chatbot that sends Telecel Cash (Ghana mobile money) payments via natural language commands. Single-user, runs locally. Built with Node.js + TypeScript.

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
4. Resolve Telecel's Paystack bank code via `GET /bank?currency=GHS&type=mobile_money`
5. Connect to WhatsApp via Baileys (QR code in terminal)

### Message handling pipeline
- `whatsapp/connection.ts` — Baileys socket setup, QR auth, auto-reconnect on disconnect (except logout)
- `whatsapp/handler.ts` — Entry point for all incoming messages. Applies **owner-only guard** (compares sender JID to `OWNER_JID`), skips `fromMe` messages, routes parsed commands to flow handlers
- `whatsapp/sender.ts` — Thin wrapper holding the socket reference for outbound messages

### Command parsing (`parser/regex.ts`)
Regex-based extraction. Returns a `ParsedCommand` with type, amount, recipient. Supports: `send <amount> to <name>`, `bal`, `history`, `contacts`, `add contact <name> <phone>`, `help`, `yes/no`.

### Conversation state (`conversation/state.ts`)
In-memory state machine (single user, no persistence needed). Two states: `IDLE` and `AWAITING_CONFIRMATION`. Pending transfers auto-cancel after 2 minutes. A non-yes/no message while awaiting confirmation cancels the pending transfer and processes the new command.

### Payment flow (`conversation/flows.ts` + `payment/paystack.ts`)
This is the critical financial path:
1. Resolve contact nickname → phone number (`contacts/resolver.ts`)
2. Validate amount against per-tx and daily limits (`payment/validator.ts`)
3. **Write transaction to SQLite with unique reference BEFORE calling Paystack** (idempotency)
4. Ask for confirmation → wait for YES/NO
5. On YES: create Paystack recipient if first transfer to this contact, check balance, call `POST /transfer`, update transaction status
6. Telecel bank code is cached in a module-level variable after startup resolution

### Key domain rules
- **All Paystack amounts are in pesewas** (1 GHS = 100 pesewas). Use `toPesewas()` / `formatGHS()` from `utils/money.ts`. Internal storage is always integer pesewas.
- **Phone numbers** exist in multiple formats: `0241234567` (local), `233241234567` (international), `233241234567@s.whatsapp.net` (JID). Normalize via `utils/phone.ts`.
- **Telecel was formerly Vodafone Ghana** — the Paystack bank code lookup searches for both "telecel" and "vodafone".
- Contact nicknames are case-insensitive (SQLite `COLLATE NOCASE`).

## Database

SQLite via `better-sqlite3` at `data/easy-send.db` (gitignored). WAL mode enabled. Migrations tracked in a `migrations` table. Schema has three tables: `contacts`, `transactions`, `scheduled_jobs`.

## Configuration

All config via `.env` (see `.env.example`). Required: `OWNER_JID`, `PAYSTACK_SECRET_KEY`. The app validates these at startup and fails fast.

## Gitignored state

- `auth_info_baileys/` — WhatsApp session credentials (re-scan QR if deleted)
- `data/*.db` — SQLite database
- `.env` — Secrets
