import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import { logger } from '../utils/logger';
import { handleMessage } from './handler';
import { setSock } from './sender';
import pino from 'pino';

const AUTH_DIR = path.join(process.cwd(), 'auth_info_baileys');

export async function startWhatsApp(): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }) as any,
  });

  setSock(sock);

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);

  // Connection status handler
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('Scan the QR code above to connect WhatsApp');
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn('Connection closed. Status: %d. Reconnecting: %s', statusCode, shouldReconnect);

      if (shouldReconnect) {
        // Reconnect after a short delay
        setTimeout(() => startWhatsApp(), 3000);
      } else {
        logger.error('Logged out. Delete auth_info_baileys/ and rescan QR code.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      logger.info('WhatsApp connected successfully!');
    }
  });

  // Listen for incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        await handleMessage(msg);
      } catch (err) {
        logger.error(err, 'Error handling message');
      }
    }
  });

  return sock;
}
