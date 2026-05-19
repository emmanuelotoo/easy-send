import { ParsedCommand } from './types';
import { consumeAmountWords, isAmountWord } from './words';

const CURRENCY_RE = /^(?:cedis|cediss|cedi|cds?|ghs|ghc|gh¢)$/i;
const PHONE_RE = /^(?:\+?233|0)\d{9}$/;
const DIGIT_AMOUNT_RE = /^\d+(?:\.\d{1,2})?$/;

/**
 * Parse a message into a structured command.
 *
 * Send patterns (all case-insensitive, "to" optional, "cedis/cds/ghs" optional):
 *   send 50 to Kojo
 *   send fifty cedis paul
 *   send twenty Cediss to rick
 *   send 30 to 0241234567
 *   send Kojo 50
 */
export function parseCommand(text: string): ParsedCommand {
  const raw = text.trim();
  const lower = raw.toLowerCase();

  if (/^(yes|y|yeah|yep|confirm|ok|okay)$/i.test(lower)) {
    return { type: 'CONFIRM', confirmValue: true, raw };
  }
  if (/^(no|n|nah|nope|cancel)$/i.test(lower)) {
    return { type: 'CONFIRM', confirmValue: false, raw };
  }

  if (/^(bal|balance)$/i.test(lower)) return { type: 'BALANCE', raw };
  if (/^(history|transactions|txns?)$/i.test(lower)) return { type: 'HISTORY', raw };
  if (/^contacts?$/i.test(lower)) return { type: 'CONTACTS', raw };
  if (/^(help|commands|\?)$/i.test(lower)) return { type: 'HELP', raw };

  const addMatch = raw.match(/^add\s+contact\s+(\w+)\s+([\d+]+)$/i);
  if (addMatch) {
    return {
      type: 'ADD_CONTACT',
      contactName: addMatch[1],
      contactPhone: addMatch[2],
      raw,
    };
  }

  const send = parseSend(raw);
  if (send) return send;

  return { type: 'UNKNOWN', raw };
}

function parseSend(raw: string): ParsedCommand | null {
  const m = raw.match(/^send\s+(.+)$/i);
  if (!m) return null;

  const body = m[1].trim();
  const tokens = body.split(/\s+/);
  if (tokens.length < 2) return null;

  // Try "amount [currency] [to] recipient"
  const amountFirst = tryAmountFirst(tokens);
  if (amountFirst) return { type: 'SEND', raw, ...amountFirst };

  // Try "recipient amount [currency]"
  const recipientFirst = tryRecipientFirst(tokens);
  if (recipientFirst) return { type: 'SEND', raw, ...recipientFirst };

  return null;
}

type SendFields = { amount: number; recipient?: string; recipientPhone?: string };

function tryAmountFirst(tokens: string[]): SendFields | null {
  let amount: number | null = null;
  let rest: string[];

  if (DIGIT_AMOUNT_RE.test(tokens[0])) {
    amount = parseFloat(tokens[0]);
    rest = tokens.slice(1);
  } else if (isAmountWord(tokens[0])) {
    const consumed = consumeAmountWords(tokens);
    if (!consumed) return null;
    [amount, rest] = consumed;
  } else {
    return null;
  }

  // Optional currency word
  if (rest.length && CURRENCY_RE.test(rest[0])) rest = rest.slice(1);
  // Optional "to"
  if (rest.length && rest[0].toLowerCase() === 'to') rest = rest.slice(1);

  if (rest.length === 0) return null;
  return { amount, ...buildRecipient(rest.join(' ')) };
}

function tryRecipientFirst(tokens: string[]): SendFields | null {
  // Walk backwards: trailing currency optional, then digit or word-amount.
  let end = tokens.length;
  if (CURRENCY_RE.test(tokens[end - 1])) end--;
  if (end < 2) return null;

  let amount: number | null = null;
  let recipientEnd = end;

  if (DIGIT_AMOUNT_RE.test(tokens[end - 1])) {
    amount = parseFloat(tokens[end - 1]);
    recipientEnd = end - 1;
  } else {
    // Try to consume trailing amount words.
    let start = end;
    while (start > 0 && isAmountWord(tokens[start - 1])) start--;
    if (start === end) return null;
    const consumed = consumeAmountWords(tokens.slice(start, end));
    if (!consumed) return null;
    amount = consumed[0];
    recipientEnd = start;
  }

  if (recipientEnd === 0) return null;
  return { amount, ...buildRecipient(tokens.slice(0, recipientEnd).join(' ')) };
}

function buildRecipient(value: string): { recipient?: string; recipientPhone?: string } {
  const cleaned = value.trim();
  const digitsOnly = cleaned.replace(/[\s-]/g, '');
  if (PHONE_RE.test(digitsOnly)) {
    return { recipientPhone: digitsOnly };
  }
  return { recipient: cleaned };
}
