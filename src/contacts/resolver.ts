import { findContactByNickname, Contact } from './store';

export interface ResolvedContact {
  contact: Contact;
  displayName: string;
  phone: string;
}

/**
 * Resolve a nickname to a full contact.
 * Returns null if no matching contact found.
 */
export function resolveRecipient(nickname: string): ResolvedContact | null {
  const contact = findContactByNickname(nickname.trim());
  if (!contact) return null;

  return {
    contact,
    displayName: contact.nickname,
    phone: contact.phone,
  };
}
