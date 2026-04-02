import { WAMessage } from '@whiskeysockets/baileys';
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
import { fromJid } from '../utils/phone';

export async function handleMessage(message: WAMessage): Promise<void> {
  // Extract text content
  const text =
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text;

  if (!text) return; // Ignore non-text messages (images, stickers, etc.)

  // Owner-only guard
  const senderJid = message.key.remoteJid;
  if (!senderJid) return;

  // For direct messages, remoteJid is the sender's JID
  const senderNumber = fromJid(senderJid);
  const ownerNumber = fromJid(config.ownerJid);

  if (senderNumber !== ownerNumber) {
    logger.debug('Ignoring message from non-owner: %s', senderNumber);
    return;
  }

  // Skip messages sent by us
  if (message.key.fromMe) return;

  logger.info('Received: %s', text);

  const reply = async (replyText: string) => {
    await sendText(senderJid, replyText);
  };

  // If awaiting confirmation, handle yes/no first
  const cmd = parseCommand(text);

  if (isAwaitingConfirmation() && cmd.type === 'CONFIRM') {
    await handleConfirmation(cmd.confirmValue!, reply);
    return;
  }

  // If awaiting confirmation but user sends something else, cancel
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
