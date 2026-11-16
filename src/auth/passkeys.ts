import crypto from 'crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { config, rpId } from '../config';
import { getDb } from '../db/client';
import { UserError } from '../utils/errors';

const RP_NAME = 'Easy-Send';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface PasskeyRow {
  id: string;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

type Purpose = 'register' | 'login';

function allPasskeys(): PasskeyRow[] {
  return getDb().prepare('SELECT * FROM passkeys ORDER BY created_at').all() as PasskeyRow[];
}

export function passkeyCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM passkeys').get() as { n: number }).n;
}

function descriptors(rows: PasskeyRow[]) {
  return rows.map(r => ({
    id: r.id,
    transports: r.transports ? (JSON.parse(r.transports) as any[]) : undefined,
  }));
}

function saveChallenge(purpose: Purpose, challenge: string): string {
  const db = getDb();
  db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').run(Date.now());
  const id = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO auth_challenges (id, purpose, challenge, expires_at) VALUES (?, ?, ?, ?)').run(
    id,
    purpose,
    challenge,
    Date.now() + CHALLENGE_TTL_MS
  );
  return id;
}

/** Fetch and delete a challenge so it can only be answered once. */
function takeChallenge(id: string | undefined, purpose: Purpose): string {
  if (!id) throw new UserError('That request expired. Try again.');
  const db = getDb();
  const row = db
    .prepare('SELECT challenge, expires_at FROM auth_challenges WHERE id = ? AND purpose = ?')
    .get(id, purpose) as { challenge: string; expires_at: number } | undefined;
  db.prepare('DELETE FROM auth_challenges WHERE id = ?').run(id);
  if (!row || row.expires_at < Date.now()) throw new UserError('That request expired. Try again.');
  return row.challenge;
}

// --- Enrollment -------------------------------------------------------------

export async function beginRegistration(): Promise<{ challengeId: string; options: unknown }> {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId,
    userName: 'owner',
    userDisplayName: 'Easy-Send owner',
    // One fixed user: a second device adds a passkey for the same account.
    userID: new TextEncoder().encode('easy-send-owner'),
    attestationType: 'none',
    excludeCredentials: descriptors(allPasskeys()),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  return { challengeId: saveChallenge('register', options.challenge), options };
}

export async function finishRegistration(
  challengeId: string | undefined,
  response: any,
  label: string | undefined
): Promise<void> {
  const expectedChallenge = takeChallenge(challengeId, 'register');
  let result;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.appOrigin,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
  } catch (err: any) {
    throw new UserError(`Could not save that passkey: ${err?.message ?? 'verification failed'}`);
  }
  if (!result.verified || !result.registrationInfo) throw new UserError('Could not save that passkey.');

  const { credential } = result.registrationInfo;
  getDb()
    .prepare('INSERT INTO passkeys (id, public_key, counter, transports, label) VALUES (?, ?, ?, ?, ?)')
    .run(
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(response?.response?.transports ?? credential.transports ?? []),
      (label || '').slice(0, 60) || null
    );
}

// --- Assertions (sign-in and per-send confirmation) -------------------------

/** Build request options. The caller decides where the challenge is stored. */
export async function buildAssertionOptions(): Promise<{ challenge: string; options: unknown }> {
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: descriptors(allPasskeys()),
    userVerification: 'required',
  });
  return { challenge: options.challenge, options };
}

/** Verify a passkey assertion against a challenge. Throws UserError when it does not check out. */
export async function verifyAssertion(response: any, expectedChallenge: string): Promise<void> {
  const row = getDb().prepare('SELECT * FROM passkeys WHERE id = ?').get(String(response?.id ?? '')) as
    | PasskeyRow
    | undefined;
  if (!row) throw new UserError('That passkey is not registered with this app.', 401);

  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.appOrigin,
      expectedRPID: rpId,
      requireUserVerification: true,
      credential: {
        id: row.id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        transports: row.transports ? JSON.parse(row.transports) : undefined,
      },
    });
  } catch {
    throw new UserError('Passkey check failed. Try again.', 401);
  }
  if (!result.verified) throw new UserError('Passkey check failed. Try again.', 401);

  getDb()
    .prepare("UPDATE passkeys SET counter = ?, last_used_at = datetime('now') WHERE id = ?")
    .run(result.authenticationInfo.newCounter, row.id);
}

export async function beginLogin(): Promise<{ challengeId: string; options: unknown }> {
  const { challenge, options } = await buildAssertionOptions();
  return { challengeId: saveChallenge('login', challenge), options };
}

export async function finishLogin(challengeId: string | undefined, response: any): Promise<void> {
  await verifyAssertion(response, takeChallenge(challengeId, 'login'));
}

// --- Setup code -------------------------------------------------------------

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
let failures: number[] = [];

/** Enrollment is open while a setup code is configured. */
export function enrollmentOpen(): boolean {
  return config.setupCode.length > 0;
}

/** Constant-time check of the setup code, with a global lockout after repeated misses. */
export function checkSetupCode(candidate: unknown): void {
  if (!enrollmentOpen()) {
    throw new UserError('Adding passkeys is locked. Set SETUP_CODE on the server to allow it.', 403);
  }
  const now = Date.now();
  failures = failures.filter(t => now - t < LOCKOUT_MS);
  if (failures.length >= MAX_FAILURES) {
    throw new UserError('Too many wrong codes. Wait 15 minutes and try again.', 429);
  }
  const a = crypto.createHash('sha256').update(String(candidate ?? '')).digest();
  const b = crypto.createHash('sha256').update(config.setupCode).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    failures.push(now);
    throw new UserError('That setup code is not right.', 401);
  }
}
