/**
 * Schema migrations, applied in order and recorded in `schema_version`.
 * Each entry runs at most once per database. Never edit a shipped migration;
 * add a new one.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
      CREATE TABLE monitors (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT    NOT NULL,
        url           TEXT    NOT NULL,
        method        TEXT    NOT NULL DEFAULT 'GET',
        expect_status INTEGER NOT NULL DEFAULT 200,
        timeout_ms    INTEGER NOT NULL DEFAULT 10000,
        interval_s    INTEGER NOT NULL DEFAULT 60,
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT    NOT NULL
      );

      CREATE TABLE checks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id  INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        checked_at  TEXT    NOT NULL,
        ok          INTEGER NOT NULL,
        status_code INTEGER,
        latency_ms  INTEGER,
        error       TEXT
      );

      CREATE INDEX idx_checks_monitor_time ON checks(monitor_id, checked_at DESC);

      CREATE TABLE incidents (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id  INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        started_at  TEXT    NOT NULL,
        resolved_at TEXT,
        reason      TEXT    NOT NULL
      );

      CREATE INDEX idx_incidents_open
        ON incidents(monitor_id, resolved_at);

      CREATE INDEX idx_incidents_started
        ON incidents(started_at DESC);
    `
  },
  {
    version: 2,
    name: 'checks-latency-index',
    sql: `
      CREATE INDEX idx_checks_time ON checks(checked_at DESC);
    `
  }
];
