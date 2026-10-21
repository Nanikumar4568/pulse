import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';

function fresh(): Database.Database {
  return new Database(':memory:');
}

describe('migrations', () => {
  it('applies every migration on a fresh database', () => {
    const db = fresh();
    const result = runMigrations(db);
    expect(result.applied).toEqual(migrations.map((m) => m.version));
    expect(result.current).toBe(Math.max(...migrations.map((m) => m.version)));
  });

  it('creates the expected tables', () => {
    const db = fresh();
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: unknown) => (r as { name: string }).name);
    expect(tables).toContain('monitors');
    expect(tables).toContain('checks');
    expect(tables).toContain('incidents');
    expect(tables).toContain('schema_version');
  });

  it('is idempotent: running twice applies nothing the second time', () => {
    const db = fresh();
    runMigrations(db);
    const second = runMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.current).toBe(Math.max(...migrations.map((m) => m.version)));
  });

  it('records the name and a timestamp for each version', () => {
    const db = fresh();
    runMigrations(db);
    const rows = db.prepare('SELECT version, name, applied_at FROM schema_version ORDER BY version').all() as Array<{
      version: number;
      name: string;
      applied_at: string;
    }>;
    expect(rows).toHaveLength(migrations.length);
    for (const r of rows) {
      expect(r.name.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(r.applied_at))).toBe(false);
    }
  });

  it('has unique, increasing version numbers', () => {
    const versions = migrations.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });

  it('enforces the foreign key from checks to monitors', () => {
    const db = fresh();
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    expect(() =>
      db.prepare('INSERT INTO checks (monitor_id, checked_at, ok) VALUES (?, ?, ?)').run(999, '2026-01-01', 1)
    ).toThrow();
  });

  it('cascades deletes from monitors to checks', () => {
    const db = fresh();
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const id = Number(
      db.prepare("INSERT INTO monitors (name, url, created_at) VALUES ('x','https://x.test','2026-01-01')").run()
        .lastInsertRowid
    );
    db.prepare('INSERT INTO checks (monitor_id, checked_at, ok) VALUES (?, ?, ?)').run(id, '2026-01-01', 1);
    db.prepare('DELETE FROM monitors WHERE id = ?').run(id);
    expect((db.prepare('SELECT COUNT(*) AS n FROM checks').get() as { n: number }).n).toBe(0);
  });
});
