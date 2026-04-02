import { config, validateConfig } from './config';
import { runMigrations, closeDb } from './db/client';
import { seedContacts } from './contacts/store';
import { startWhatsApp } from './whatsapp/connection';
import { initPaymentProvider } from './conversation/flows';
import { logger } from './utils/logger';
import fs from 'fs';
import path from 'path';

async function main() {
  logger.info('Starting Easy-Send...');

  // Validate configuration
  validateConfig();

  // Run database migrations
  runMigrations();

  // Seed contacts from JSON if table is empty
  const contactsFile = path.join(process.cwd(), 'data', 'contacts.json');
  if (fs.existsSync(contactsFile)) {
    const contacts = JSON.parse(fs.readFileSync(contactsFile, 'utf-8'));
    seedContacts(contacts);
    logger.info('Contacts seeded: %d entries', contacts.length);
  }

  // Resolve Telecel bank code from Paystack
  await initPaymentProvider();

  // Start WhatsApp connection
  await startWhatsApp();

  logger.info('Easy-Send is running. Waiting for WhatsApp messages...');
}

// Graceful shutdown
function shutdown() {
  logger.info('Shutting down...');
  closeDb();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  logger.fatal(err, 'Uncaught exception');
  closeDb();
  process.exit(1);
});

main().catch((err) => {
  logger.fatal(err, 'Failed to start');
  process.exit(1);
});
