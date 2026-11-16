import { getDb } from '../db/client';
import { detectNetwork, toInternational } from '../utils/phone';
import { UserError } from '../utils/errors';

export interface Contact {
  id: number;
  nickname: string;
  phone: string;
  recipient_code: string | null;
  created_at: string;
}

const MAX_NAME_LENGTH = 40;

function cleanNickname(nickname: string): string {
  const name = String(nickname ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new UserError('Give the contact a name.');
  if (name.length > MAX_NAME_LENGTH) throw new UserError(`Keep the name under ${MAX_NAME_LENGTH} characters.`);
  // A name made only of digits would be ambiguous with phone numbers and amounts.
  if (/^[\d\s+.-]+$/.test(name)) throw new UserError('A contact name needs at least one letter.');
  return name;
}

function cleanPhone(phone: string): string {
  const intl = toInternational(String(phone ?? ''));
  if (!detectNetwork(intl)) {
    throw new UserError('That is not an MTN, Telecel or AirtelTigo number.');
  }
  return intl;
}

export function findContactByNickname(nickname: string): Contact | undefined {
  return getDb()
    .prepare('SELECT * FROM contacts WHERE nickname = ? COLLATE NOCASE')
    .get(nickname.trim()) as Contact | undefined;
}

export function findContactById(id: number): Contact | undefined {
  return getDb().prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Contact | undefined;
}

export function getAllContacts(): Contact[] {
  return getDb().prepare('SELECT * FROM contacts ORDER BY nickname COLLATE NOCASE').all() as Contact[];
}

export function addContact(nickname: string, phone: string): Contact {
  const name = cleanNickname(nickname);
  const intl = cleanPhone(phone);
  const existing = findContactByNickname(name);
  if (existing) throw new UserError(`You already have a contact called ${existing.nickname}.`, 409);
  const info = getDb().prepare('INSERT INTO contacts (nickname, phone) VALUES (?, ?)').run(name, intl);
  return findContactById(Number(info.lastInsertRowid))!;
}

export function updateContact(id: number, changes: { nickname?: string; phone?: string }): Contact {
  const current = findContactById(id);
  if (!current) throw new UserError('Contact not found.', 404);

  const name = changes.nickname !== undefined ? cleanNickname(changes.nickname) : current.nickname;
  const phone = changes.phone !== undefined ? cleanPhone(changes.phone) : current.phone;

  const clash = findContactByNickname(name);
  if (clash && clash.id !== id) throw new UserError(`You already have a contact called ${clash.nickname}.`, 409);

  // A new number means the cached Paystack recipient no longer applies.
  const recipientCode = phone === current.phone ? current.recipient_code : null;
  getDb()
    .prepare('UPDATE contacts SET nickname = ?, phone = ?, recipient_code = ? WHERE id = ?')
    .run(name, phone, recipientCode, id);
  return findContactById(id)!;
}

export function deleteContact(id: number): void {
  const db = getDb();
  db.transaction(() => {
    // History keeps its own copy of the name and number, so just detach it.
    db.prepare('UPDATE transactions SET contact_id = NULL WHERE contact_id = ?').run(id);
    db.prepare('UPDATE scheduled_jobs SET contact_id = NULL WHERE contact_id = ?').run(id);
    const info = db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    if (info.changes === 0) throw new UserError('Contact not found.', 404);
  })();
}

export function updateRecipientCode(contactId: number, recipientCode: string): void {
  getDb().prepare('UPDATE contacts SET recipient_code = ? WHERE id = ?').run(recipientCode, contactId);
}

/** Import contacts from data/contacts.json on first run. Existing names are left alone. */
export function seedContacts(contacts: Array<{ nickname: string; phone: string }>): void {
  const db = getDb();
  const insert = db.prepare('INSERT OR IGNORE INTO contacts (nickname, phone) VALUES (?, ?)');
  db.transaction((items: typeof contacts) => {
    for (const c of items) insert.run(c.nickname, toInternational(c.phone));
  })(contacts);
}
