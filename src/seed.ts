/**
 * Seed Pulse with 90 days of plausible history so a fresh install has something
 * to show, then register live monitors that keep checking for real.
 *
 *   npm run seed            # dev  (tsx)
 *   node dist/seed.js       # prod (inside the container)
 *
 * Rows written here are synthetic and the README says so. Every check the
 * scheduler writes afterwards is a genuine network probe.
 */
import { openDb, runMigrations } from './db/index.js';
import type { DB } from './db/index.js';

export interface SeedMonitor {
  name: string;
  url: string;
  expectStatus: number;
  intervalS: number;
  /** baseline latency in ms */
  base: number;
  /** probability that any single check fails */
  failRate: number;
  /** [days ago the outage starts, how many minutes it lasts] */
  outages: Array<[number, number]>;
}

export const SEED_MONITORS: SeedMonitor[] = [
  {
    name: 'GitHub',
    url: 'https://github.com',
    expectStatus: 200,
    intervalS: 300,
    base: 180,
    failRate: 0.001,
    outages: [[61, 22]]
  },
  {
    name: 'Cloudflare DNS',
    url: 'https://1.1.1.1',
    expectStatus: 200,
    intervalS: 300,
    base: 24,
    failRate: 0.0005,
    outages: []
  },
  {
    name: 'npm registry',
    url: 'https://registry.npmjs.org/-/ping',
    expectStatus: 200,
    intervalS: 300,
    base: 95,
    failRate: 0.002,
    outages: [[34, 8], [12, 4]]
  },
  {
    name: 'Wikipedia',
    url: 'https://en.wikipedia.org',
    expectStatus: 200,
    intervalS: 300,
    base: 140,
    failRate: 0.001,
    outages: []
  }
];

const DAYS = 90;

/**
 * Deterministic PRNG so seeding twice produces identical history — useful when
 * comparing screenshots or debugging a report.
 */
function makeRandom(seed = 1337): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

export interface SeedResult {
  inserted: number;
  checks: number;
  skipped: boolean;
}

export function seed(db: DB, opts: { force?: boolean; now?: Date } = {}): SeedResult {
  const now = (opts.now ?? new Date()).getTime();
  const existing = db.prepare('SELECT COUNT(*) AS n FROM monitors').get() as { n: number };
  if (existing.n > 0 && !opts.force) {
    return { inserted: 0, checks: 0, skipped: true };
  }

  const rand = makeRandom();
  const startedAt = new Date(now - DAYS * 86400_000).toISOString();

  const insertMonitor = db.prepare(
    `INSERT INTO monitors (name, url, method, expect_status, timeout_ms, interval_s, active, created_at)
     VALUES (?, ?, 'GET', ?, 10000, ?, 1, ?)`
  );
  const insertCheck = db.prepare(
    `INSERT INTO checks (monitor_id, checked_at, ok, status_code, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertIncident = db.prepare(
    `INSERT INTO incidents (monitor_id, started_at, resolved_at, reason) VALUES (?, ?, ?, ?)`
  );

  let inserted = 0;
  let checks = 0;

  const run = db.transaction(() => {
    for (const cfg of SEED_MONITORS) {
      const info = insertMonitor.run(cfg.name, cfg.url, cfg.expectStatus, cfg.intervalS, startedAt);
      const monitorId = Number(info.lastInsertRowid);
      inserted += 1;

      for (let day = DAYS; day >= 0; day--) {
        const dayStart = now - day * 86400_000;
        const perDay = Math.floor((86400 / cfg.intervalS) * 0.85);

        for (let i = 0; i < perDay; i++) {
          const ts = dayStart + (i / perDay) * 86400_000;
          if (ts > now) continue;

          const minutesAgo = (now - ts) / 60_000;
          const duringOutage = cfg.outages.some(
            ([outageDay, minutes]) =>
              minutesAgo <= outageDay * 1440 && minutesAgo >= outageDay * 1440 - minutes
          );

          const ok = !duringOutage && rand() > cfg.failRate;
          const latency = Math.round(cfg.base * (0.75 + rand() * 0.7));

          insertCheck.run(
            monitorId,
            new Date(ts).toISOString(),
            ok ? 1 : 0,
            ok ? cfg.expectStatus : 503,
            ok ? latency : null,
            ok ? null : 'expected 200, got 503'
          );
          checks += 1;
        }
      }

      for (const [outageDay, minutes] of cfg.outages) {
        const end = now - outageDay * 1440 * 60_000;
        const start = end - minutes * 60_000;
        insertIncident.run(
          monitorId,
          new Date(start).toISOString(),
          new Date(end).toISOString(),
          'expected 200, got 503'
        );
      }
    }

    // a monitor that has never been checked, so the empty state is exercised too
    insertMonitor.run(
      'Status page (self)',
      'http://localhost:3000/status',
      200,
      60,
      new Date(now).toISOString()
    );
    inserted += 1;
  });

  run();
  return { inserted, checks, skipped: false };
}

// ---- CLI ----
const isCli = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  const dbPath = process.env.DB_PATH ?? 'pulse.db';
  const db = openDb(dbPath);
  runMigrations(db);
  const force = process.argv.includes('--force');
  const result = seed(db, { force });

  if (result.skipped) {
    console.log(`database ${dbPath} already has monitors; pass --force to add another set`);
  } else {
    console.log(`seeded ${result.inserted} monitors and ${result.checks} checks into ${dbPath}`);
  }
  db.close();
}
