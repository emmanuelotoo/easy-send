import fs from 'fs';
import path from 'path';
import { config, isSecureOrigin, rpId, validateConfig } from './config';
import { enrollmentOpen, passkeyCount } from './auth/passkeys';
import { seedContacts } from './contacts/store';
import { closeDb, runMigrations } from './db/client';
import { buildServer } from './http/server';
import { initPaymentProvider, startReconciler, stopReconciler } from './transfers/service';
import { logger } from './utils/logger';

async function main() {
  logger.info('Starting Easy-Send...');

  validateConfig();
  runMigrations();

  const contactsFile = path.join(config.dataDir, 'contacts.json');
  if (fs.existsSync(contactsFile)) {
    const contacts = JSON.parse(fs.readFileSync(contactsFile, 'utf-8'));
    seedContacts(contacts);
    logger.info('Contacts seeded: %d entries', contacts.length);
  }

  try {
    await initPaymentProvider();
  } catch (err: any) {
    // Not fatal: the networks are looked up again on the first send.
    logger.warn('Paystack is not reachable yet: %s', err?.message);
  }

  if (passkeyCount() === 0 && !enrollmentOpen()) {
    throw new Error('No passkey exists and SETUP_CODE is not set. Set SETUP_CODE in .env to enroll your first device.');
  }
  if (!isSecureOrigin && rpId !== 'localhost') {
    logger.warn('APP_ORIGIN is %s. Passkeys and installing the app need HTTPS (or localhost).', config.appOrigin);
  }

  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
  startReconciler();

  logger.info('Easy-Send is running at %s', config.appOrigin);

  const shutdown = async () => {
    logger.info('Shutting down...');
    stopReconciler();
    await app.close().catch(() => undefined);
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  logger.fatal(err, 'Failed to start');
  process.exit(1);
});
