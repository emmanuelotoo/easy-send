import { ParsedCommand } from './types';

/**
 * Parse a message into a structured command using regex.
 *
 * Supported patterns:
 *   "send 50 to Kojo"
 *   "send 20 cedis to Ama"
 *   "send 10.50 to Mom"
 *   "bal" / "balance"
 *   "history"
 *   "contacts"
 *   "add contact Kwame 0241234567"
 *   "help"
 *   "yes" / "no"
 */
export function parseCommand(text: string): ParsedCommand {
  const raw = text.trim();
  const lower = raw.toLowerCase();

  // Confirmation: yes/no/y/n
  if (/^(yes|y|yeah|yep|confirm)$/i.test(lower)) {
    return { type: 'CONFIRM', confirmValue: true, raw };
  }
  if (/^(no|n|nah|nope|cancel)$/i.test(lower)) {
    return { type: 'CONFIRM', confirmValue: false, raw };
  }

  // Balance
  if (/^(bal|balance)$/i.test(lower)) {
    return { type: 'BALANCE', raw };
  }

  // History
  if (/^(history|transactions|txns?)$/i.test(lower)) {
    return { type: 'HISTORY', raw };
  }

  // Contacts list
  if (/^contacts?$/i.test(lower)) {
    return { type: 'CONTACTS', raw };
  }

  // Help
  if (/^(help|commands|\?)$/i.test(lower)) {
    return { type: 'HELP', raw };
  }

  // Add contact: "add contact Kwame 0241234567"
  const addMatch = raw.match(
    /^add\s+contact\s+(\w+)\s+([\d+]+)$/i
  );
  if (addMatch) {
    return {
      type: 'ADD_CONTACT',
      contactName: addMatch[1],
      contactPhone: addMatch[2],
      raw,
    };
  }

  // Send: "send 50 to Kojo" or "send 50 cedis to Kojo" or "send 50 ghs to Kojo"
  const sendMatch = raw.match(
    /^send\s+(\d+(?:\.\d{1,2})?)\s*(?:cedis?|ghs?)?\s+to\s+(.+)$/i
  );
  if (sendMatch) {
    return {
      type: 'SEND',
      amount: parseFloat(sendMatch[1]),
      recipient: sendMatch[2].trim(),
      raw,
    };
  }

  // Alternative: "send Kojo 50" (name first, then amount)
  const sendAltMatch = raw.match(
    /^send\s+(\w+)\s+(\d+(?:\.\d{1,2})?)\s*(?:cedis?|ghs?)?$/i
  );
  if (sendAltMatch) {
    return {
      type: 'SEND',
      recipient: sendAltMatch[1].trim(),
      amount: parseFloat(sendAltMatch[2]),
      raw,
    };
  }

  return { type: 'UNKNOWN', raw };
}
