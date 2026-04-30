import { Context } from 'grammy';
import { config } from '../config';
import { parseCommand } from '../parser/regex';
import { isAwaitingConfirmation, isAwaitingVoucher } from '../conversation/state';
import {
  handleSend,
  handleConfirmation,
  handleVoucher,
  handleBalance,
  handleHistory,
  handleContacts,
  handleAddContact,
  handleHelp,
} from '../conversation/flows';
import { sendText } from './bot';
import { logger } from '../utils/logger';

export async function handleMessage(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text) return;

  // Owner-only guard
  const senderId = ctx.from?.id;
  if (!senderId) return;

  if (senderId !== config.ownerTelegramId) {
    logger.debug('Ignoring message from non-owner: %d', senderId);
    return;
  }

  logger.info('Received: %s', text);

  const chatId = ctx.chat!.id;
  const reply = async (replyText: string) => {
    await sendText(chatId, replyText);
  };

  // If awaiting voucher, treat any input as voucher/OTP submission
  if (isAwaitingVoucher()) {
    await handleVoucher(text, reply);
    return;
  }

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
      await reply('Unknown command. Type help for available commands.');
      break;
  }
}
