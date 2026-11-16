/**
 * A software passkey for tests. It produces the same JSON a browser would send
 * after navigator.credentials.create() / .get(), signed with a real ES256 key,
 * so the server's WebAuthn verification runs for real.
 */
import crypto from 'crypto';

const b64url = (buf: Uint8Array) => Buffer.from(buf).toString('base64url');
const sha256 = (data: Uint8Array | string) => crypto.createHash('sha256').update(data).digest();

// --- Just enough CBOR to encode an attestation object and a COSE key ---------

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
}

function cbor(value: unknown): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error('unsupported CBOR value');
}

export class TestAuthenticator {
  private readonly keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private readonly credentialId = crypto.randomBytes(16);
  private counter = 0;

  constructor(private readonly origin: string, private readonly rpId: string) {}

  get id(): string {
    return b64url(this.credentialId);
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  private authData(flags: number, attested?: Buffer): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++this.counter);
    return Buffer.concat([sha256(this.rpId), Buffer.from([flags]), count, attested ?? Buffer.alloc(0)]);
  }

  /** Answer to navigator.credentials.create(). */
  register(options: { challenge: string }) {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    const coseKey = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ])
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, coseKey]);
    // flags: user present | user verified | attested credential data
    const authData = this.authData(0x45, attested);
    const attestationObject = cbor(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ])
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** Answer to navigator.credentials.get(). Pass userVerified=false to simulate a skipped biometric. */
  assert(options: { challenge: string }, userVerified = true) {
    const clientDataJSON = this.clientData('webauthn.get', options.challenge);
    const authData = this.authData(userVerified ? 0x05 : 0x01);
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
