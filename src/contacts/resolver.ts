import { findContactByNickname, Contact } from './store';
import { toInternational, toLocal } from '../utils/phone';

export interface ResolvedContact {
  /** Database contact, or null for ad-hoc raw-phone recipients */
  contact: Contact | null;
  displayName: string;
  phone: string;
  recipientCode: string | null;
}

/** Resolve a saved nickname to a contact. */
export function resolveRecipient(nickname: string): ResolvedContact | null {
  const contact = findContactByNickname(nickname.trim());
  if (!contact) return null;
  return {
    contact,
    displayName: contact.nickname,
    phone: contact.phone,
    recipientCode: contact.recipient_code,
  };
}

/** Build a synthetic resolved contact for an ad-hoc raw phone number (no DB row). */
export function resolveAdhocPhone(phone: string): ResolvedContact {
  const intl = toInternational(phone);
  return {
    contact: null,
    displayName: toLocal(intl),
    phone: intl,
    recipientCode: null,
  };
}
