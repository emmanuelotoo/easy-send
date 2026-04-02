import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

const DB_PATH = path.join(process.cwd(), 'data', 'easy-send.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    // Ensure data directory exists
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    logger.info('Database connected: %s', DB_PATH);
  }
  return db;
}

export function runMigrations(): void {
  const database = getDb();

  // Track applied migrations
  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    database
      .prepare('SELECT name FROM migrations')
      .all()
      .map((row: any) => row.name)
  );

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    database.exec(sql);
    database.prepare('INSERT INTO migrations (name) VALUES (?)').run(file);
    logger.info('Applied migration: %s', file);
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    logger.info('Database closed');
  }
}
