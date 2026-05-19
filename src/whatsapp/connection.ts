import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { handleMessage } from './handler';

let sock: WASocket | null = null;
let stopping = false;

export async function startWhatsapp(): Promise<void> {
  stopping = false;
  await connect();
}

async function connect(): Promise<void> {
  const authDir = path.resolve(config.whatsappAuthDir);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: logger.child({ module: 'baileys' }) as any,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      logger.info('Scan this QR code with WhatsApp on your phone to pair:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      logger.info('WhatsApp connected');
    }
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      if (loggedOut) {
        logger.error('WhatsApp logged out — delete %s and re-pair.', authDir);
        return;
      }
      if (!stopping) {
        logger.warn({ statusCode }, 'WhatsApp disconnected — reconnecting in 3s');
        setTimeout(() => connect().catch(err => logger.error(err, 'Reconnect failed')), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleMessage(msg, sock!);
      } catch (err) {
        logger.error(err, 'Error handling WhatsApp message');
      }
    }
  });
}

export function stopWhatsapp(): void {
  stopping = true;
  if (sock) {
    sock.end(undefined);
    sock = null;
  }
}

export function getSocket(): WASocket | null {
  return sock;
}
