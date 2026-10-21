import Database from 'better-sqlite3';
import { migrations } from './migrations.js';

export type DB = Database.Database;

export interface MigrationResult {
  applied: number[];
  current: number;
}

/**
 * Open a database and bring it up to the latest schema version.
 * Safe to call on every boot: already-applied migrations are skipped.
 */
export function openDb(path = process.env.DB_PATH ?? 'pulse.db'): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function runMigrations(db: DB): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set<number>(
    db.prepare('SELECT version FROM schema_version').all().map((r: unknown) => (r as { version: number }).version)
  );

  const ran: number[] = [];
  const insert = db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)');

  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.version, m.name, new Date().toISOString());
    })();
    ran.push(m.version);
  }

  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
  return { applied: ran, current: row.v ?? 0 };
}
