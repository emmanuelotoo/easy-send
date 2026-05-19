import { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { config } from '../config';
import { parseCommand } from '../parser/regex';
import { isAwaitingConfirmation } from '../conversation/state';
import {
  handleSend,
  handleConfirmation,
  handleBalance,
  handleHistory,
  handleContacts,
  handleAddContact,
  handleHelp,
} from '../conversation/flows';
import { sendText } from './sender';
import { logger } from '../utils/logger';

function extractText(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  return m.conversation
    ?? m.extendedTextMessage?.text
    ?? m.imageMessage?.caption
    ?? m.videoMessage?.caption
    ?? null;
}

export async function handleMessage(msg: WAMessage, sock: WASocket): Promise<void> {
  // Skip self-sent and statuses
  if (msg.key.fromMe) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  // Skip groups (we only DM the owner)
  if (jid.endsWith('@g.us')) return;

  // Owner-only guard
  if (jid !== config.ownerWhatsappJid) {
    logger.debug('Ignoring message from non-owner: %s', jid);
    return;
  }

  const text = extractText(msg);
  if (!text) return;

  logger.info('Received: %s', text);

  const reply = async (replyText: string) => {
    await sendText(sock, jid, replyText);
  };

  const cmd = parseCommand(text);

  if (isAwaitingConfirmation() && cmd.type === 'CONFIRM') {
    await handleConfirmation(cmd.confirmValue!, reply);
    return;
  }

  if (isAwaitingConfirmation() && cmd.type !== 'CONFIRM') {
    await handleConfirmation(false, reply);
    await reply('Previous transfer cancelled. Processing new command...');
  }

  switch (cmd.type) {
    case 'SEND':
      await handleSend(cmd, reply);
      break;
    case 'BALANCE':
      await handleBalance(reply);
      break;
    case 'HISTORY':
      await handleHistory(reply);
      break;
    case 'CONTACTS':
      await handleContacts(reply);
      break;
    case 'ADD_CONTACT':
      await handleAddContact(cmd, reply);
      break;
    case 'HELP':
      await handleHelp(reply);
      break;
    case 'CONFIRM':
      await reply('Nothing to confirm. Send a command first.');
      break;
    case 'UNKNOWN':
      await reply('Unknown command. Type *help* for available commands.');
      break;
  }
}
