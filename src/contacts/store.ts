import { getDb } from '../db/client';
import { toInternational } from '../utils/phone';

export interface Contact {
  id: number;
  nickname: string;
  phone: string;
  recipient_code: string | null;
  created_at: string;
}

export function findContactByNickname(nickname: string): Contact | undefined {
  const db = getDb();
  return db
    .prepare('SELECT * FROM contacts WHERE nickname = ? COLLATE NOCASE')
    .get(nickname) as Contact | undefined;
}

export function getAllContacts(): Contact[] {
  const db = getDb();
  return db.prepare('SELECT * FROM contacts ORDER BY nickname').all() as Contact[];
}

export function addContact(nickname: string, phone: string): Contact {
  const db = getDb();
  const normalized = toInternational(phone);
  db.prepare('INSERT INTO contacts (nickname, phone) VALUES (?, ?)').run(nickname, normalized);
  return findContactByNickname(nickname)!;
}

export function updateRecipientCode(contactId: number, recipientCode: string): void {
  const db = getDb();
  db.prepare('UPDATE contacts SET recipient_code = ? WHERE id = ?').run(recipientCode, contactId);
}

export function seedContacts(contacts: Array<{ nickname: string; phone: string }>): void {
  const db = getDb();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO contacts (nickname, phone) VALUES (?, ?)'
  );

  const runAll = db.transaction((items: typeof contacts) => {
    for (const c of items) {
      insert.run(c.nickname, toInternational(c.phone));
    }
  });

  runAll(contacts);
}
