import crypto from 'crypto';
import { config } from '../config';
import { getDb } from '../db/client';

export const SESSION_COOKIE = 'es_session';

function hash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Create a session and return the cookie value. Only its hash is stored. */
export function createSession(): string {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').run(
    hash(token),
    Date.now() + config.sessionTtlMs
  );
  return token;
}

export function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const row = getDb().prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hash(token)) as
    | { expires_at: number }
    | undefined;
  return !!row && row.expires_at > Date.now();
}

export function destroySession(token: string | undefined): void {
  if (token) getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
}
