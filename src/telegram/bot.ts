import { Bot } from 'grammy';
import { config } from '../config';
import { handleMessage } from './handler';
import { logger } from '../utils/logger';

const bot = new Bot(config.telegramBotToken);

// Route all text messages to handler
bot.on('message:text', async (ctx) => {
  await handleMessage(ctx);
});

/** Send a text message to a chat */
export async function sendText(chatId: number, text: string): Promise<void> {
  await bot.api.sendMessage(chatId, text);
}

/** Start the bot with long polling */
export async function startTelegram(): Promise<void> {
  bot.catch((err) => {
    logger.error(err, 'Telegram bot error');
  });

  // Non-blocking start — bot runs in background
  bot.start({
    onStart: () => {
      logger.info('Telegram bot started');
    },
  });
}

/** Stop the bot gracefully */
export function stopTelegram(): void {
  bot.stop();
}
