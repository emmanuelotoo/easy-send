// Thin wrappers around navigator.credentials that speak the JSON shapes the
// server expects, so no library is needed in the browser.

function toBuffer(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0)).buffer;
}

function toBase64url(buffer) {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function passkeysSupported() {
  return window.isSecureContext && 'credentials' in navigator && typeof PublicKeyCredential !== 'undefined';
}

/** Turn a WebAuthn failure into something a person can act on. */
export function passkeyError(err) {
  if (!passkeysSupported()) {
    return window.isSecureContext
      ? 'This browser does not support passkeys.'
      : 'Passkeys only work over HTTPS. Open the app from its https:// address.';
  }
  switch (err?.name) {
    case 'NotAllowedError':
      return 'The passkey prompt was dismissed. Nothing was sent.';
    case 'InvalidStateError':
      return 'This device already has a passkey for Easy-Send.';
    case 'SecurityError':
      return 'This address does not match the one the app was set up for.';
    default:
      return err?.message || 'The passkey check did not complete.';
  }
}

export async function createPasskey(options) {
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: toBuffer(options.challenge),
      user: { ...options.user, id: toBuffer(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map(c => ({ ...c, id: toBuffer(c.id) })),
    },
  });
  const { response } = credential;
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      attestationObject: toBase64url(response.attestationObject),
      transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

export async function getAssertion(options) {
  const credential = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: toBuffer(options.challenge),
      allowCredentials: (options.allowCredentials || []).map(c => ({ ...c, id: toBuffer(c.id) })),
    },
  });
  const { response } = credential;
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      authenticatorData: toBase64url(response.authenticatorData),
      signature: toBase64url(response.signature),
      userHandle: response.userHandle ? toBase64url(response.userHandle) : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}
