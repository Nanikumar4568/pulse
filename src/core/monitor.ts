import type { DB } from '../db/index.js';
import { checkMonitor, type FetchLike } from './checker.js';
import {
  averageLatency,
  dailyBuckets,
  round2,
  stateForPct,
  summarise,
  worstState
} from './uptime.js';
import type { Check, CheckResult, Monitor, MonitorStatus } from './types.js';
import { noopNotifier, type Notifier } from './notifier.js';

interface MonitorRow {
  id: number;
  name: string;
  url: string;
  method: string;
  expect_status: number;
  timeout_ms: number;
  interval_s: number;
  active: number;
  created_at: string;
}

interface CheckRow {
  id: number;
  monitor_id: number;
  checked_at: string;
  ok: number;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
}

function toMonitor(r: MonitorRow): Monitor {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    method: r.method,
    expectStatus: r.expect_status,
    timeoutMs: r.timeout_ms,
    intervalS: r.interval_s,
    active: r.active === 1,
    createdAt: r.created_at
  };
}

function toCheck(r: CheckRow): Check {
  return {
    id: r.id,
    monitorId: r.monitor_id,
    checkedAt: r.checked_at,
    ok: r.ok === 1,
    statusCode: r.status_code,
    latencyMs: r.latency_ms,
    error: r.error
  };
}

export interface CreateMonitorInput {
  name: string;
  url: string;
  method?: string;
  expectStatus?: number;
  timeoutMs?: number;
  intervalS?: number;
}

export interface ValidationError {
  field: string;
  message: string;
}

export function validateMonitor(input: Partial<CreateMonitorInput>): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!input.name || !input.name.trim()) {
    errors.push({ field: 'name', message: 'name is required' });
  } else if (input.name.length > 80) {
    errors.push({ field: 'name', message: 'name must be 80 characters or fewer' });
  }

  if (!input.url || !input.url.trim()) {
    errors.push({ field: 'url', message: 'url is required' });
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(input.url);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      errors.push({ field: 'url', message: 'url must be an absolute http(s) URL' });
    }
  }

  if (input.expectStatus !== undefined) {
    if (!Number.isInteger(input.expectStatus) || input.expectStatus < 100 || input.expectStatus > 599) {
      errors.push({ field: 'expectStatus', message: 'expectStatus must be an integer HTTP status' });
    }
  }
  if (input.timeoutMs !== undefined) {
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 60000) {
      errors.push({ field: 'timeoutMs', message: 'timeoutMs must be between 1000 and 60000' });
    }
  }
  if (input.intervalS !== undefined) {
    if (!Number.isInteger(input.intervalS) || input.intervalS < 30 || input.intervalS > 86400) {
      errors.push({ field: 'intervalS', message: 'intervalS must be between 30 and 86400' });
    }
  }
  return errors;
}

export interface MonitorStoreOptions {
  /** called after an incident opens or resolves; never allowed to throw into a check */
  notify?: Notifier;
}

export class MonitorStore {
  private readonly notify: Notifier;

  constructor(private readonly db: DB, opts: MonitorStoreOptions = {}) {
    this.notify = opts.notify ?? noopNotifier;
  }

  list(): Monitor[] {
    const rows = this.db.prepare('SELECT * FROM monitors ORDER BY id').all() as MonitorRow[];
    return rows.map(toMonitor);
  }

  get(id: number): Monitor | null {
    const row = this.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as MonitorRow | undefined;
    return row ? toMonitor(row) : null;
  }

  create(input: CreateMonitorInput, now: Date = new Date()): Monitor {
    const info = this.db
      .prepare(
        `INSERT INTO monitors (name, url, method, expect_status, timeout_ms, interval_s, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        input.name.trim(),
        input.url.trim(),
        (input.method ?? 'GET').toUpperCase(),
        input.expectStatus ?? 200,
        input.timeoutMs ?? 10000,
        input.intervalS ?? 60,
        now.toISOString()
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  update(id: number, patch: Partial<CreateMonitorInput> & { active?: boolean }): Monitor | null {
    const existing = this.get(id);
    if (!existing) return null;

    const next = {
      name: patch.name ?? existing.name,
      url: patch.url ?? existing.url,
      method: (patch.method ?? existing.method).toUpperCase(),
      expect_status: patch.expectStatus ?? existing.expectStatus,
      timeout_ms: patch.timeoutMs ?? existing.timeoutMs,
      interval_s: patch.intervalS ?? existing.intervalS,
      active: patch.active === undefined ? (existing.active ? 1 : 0) : patch.active ? 1 : 0
    };

    this.db
      .prepare(
        `UPDATE monitors
            SET name = ?, url = ?, method = ?, expect_status = ?, timeout_ms = ?, interval_s = ?, active = ?
          WHERE id = ?`
      )
      .run(next.name, next.url, next.method, next.expect_status, next.timeout_ms, next.interval_s, next.active, id);

    return this.get(id);
  }

  remove(id: number): boolean {
    const info = this.db.prepare('DELETE FROM monitors WHERE id = ?').run(id);
    return info.changes > 0;
  }

  checksFor(id: number, limit = 500): Check[] {
    const rows = this.db
      .prepare('SELECT * FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT ?')
      .all(id, limit) as CheckRow[];
    return rows.map(toCheck);
  }

  checksForRange(id: number, days: number, now: Date = new Date()): Check[] {
    const since = new Date(now.getTime() - days * 86400_000).toISOString();
    const rows = this.db
      .prepare('SELECT * FROM checks WHERE monitor_id = ? AND checked_at >= ? ORDER BY checked_at ASC')
      .all(id, since) as CheckRow[];
    return rows.map(toCheck);
  }

  allChecksSince(sinceIso: string): Check[] {
    const rows = this.db
      .prepare('SELECT * FROM checks WHERE checked_at >= ? ORDER BY checked_at ASC')
      .all(sinceIso) as CheckRow[];
    return rows.map(toCheck);
  }

  lastCheck(id: number): Check | null {
    const row = this.db
      .prepare('SELECT * FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 1')
      .get(id) as CheckRow | undefined;
    return row ? toCheck(row) : null;
  }

  openIncident(id: number): { id: number; startedAt: string; reason: string } | null {
    const row = this.db
      .prepare(
        'SELECT id, started_at, reason FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1'
      )
      .get(id) as { id: number; started_at: string; reason: string } | undefined;
    return row ? { id: row.id, startedAt: row.started_at, reason: row.reason } : null;
  }

  incidents(limit = 50): Array<{ id: number; monitorId: number; startedAt: string; resolvedAt: string | null; reason: string }> {
    const rows = this.db
      .prepare('SELECT * FROM incidents ORDER BY started_at DESC LIMIT ?')
      .all(limit) as Array<{
      id: number;
      monitor_id: number;
      started_at: string;
      resolved_at: string | null;
      reason: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      monitorId: r.monitor_id,
      startedAt: r.started_at,
      resolvedAt: r.resolved_at,
      reason: r.reason
    }));
  }

  /**
   * Record a check and maintain incident state.
   *
   * A failure opens an incident only if one isn't already open, so a monitor
   * that is down for an hour produces one incident, not sixty. A success
   * resolves any open incident.
   */
  recordCheck(monitorId: number, result: CheckResult, now: Date = new Date()): Check {
    const checkedAt = now.toISOString();

    const insert = this.db.prepare(
      `INSERT INTO checks (monitor_id, checked_at, ok, status_code, latency_ms, error)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    // collected inside the transaction, dispatched after it commits so a webhook
    // can never observe an incident that got rolled back
    let transition: { kind: 'opened'; reason: string } | { kind: 'resolved'; openedAt: string } | null = null;

    const run = this.db.transaction(() => {
      const info = insert.run(
        monitorId,
        checkedAt,
        result.ok ? 1 : 0,
        result.statusCode,
        result.latencyMs,
        result.error
      );

      if (!result.ok) {
        const open = this.openIncident(monitorId);
        if (!open) {
          this.db
            .prepare('INSERT INTO incidents (monitor_id, started_at, resolved_at, reason) VALUES (?, ?, NULL, ?)')
            .run(monitorId, checkedAt, result.error ?? 'check failed');
          transition = { kind: 'opened', reason: result.error ?? 'check failed' };
        }
      } else {
        const open = this.openIncident(monitorId);
        if (open) {
          this.db
            .prepare('UPDATE incidents SET resolved_at = ? WHERE monitor_id = ? AND resolved_at IS NULL')
            .run(checkedAt, monitorId);
          transition = { kind: 'resolved', openedAt: open.startedAt };
        }
      }

      return Number(info.lastInsertRowid);
    });

    const id = run();
    const row = this.db.prepare('SELECT * FROM checks WHERE id = ?').get(id) as CheckRow;
    const check = toCheck(row);

    if (transition) {
      this.dispatch(monitorId, checkedAt, transition);
    }
    return check;
  }

  /** Fire the notifier, swallowing anything it throws — alerts must not break checks. */
  private dispatch(
    monitorId: number,
    at: string,
    transition: { kind: 'opened'; reason: string } | { kind: 'resolved'; openedAt: string }
  ): void {
    const monitor = this.get(monitorId);
    if (!monitor) return;

    try {
      if (transition.kind === 'opened') {
        this.notify({
          event: 'incident.opened',
          monitorId,
          monitorName: monitor.name,
          url: monitor.url,
          at,
          reason: transition.reason
        });
      } else {
        const opened = Date.parse(transition.openedAt);
        const closed = Date.parse(at);
        this.notify({
          event: 'incident.resolved',
          monitorId,
          monitorName: monitor.name,
          url: monitor.url,
          at,
          durationS:
            Number.isNaN(opened) || Number.isNaN(closed)
              ? 0
              : Math.max(0, Math.round((closed - opened) / 1000))
        });
      }
    } catch (err) {
      // a broken notifier is not a broken monitor
      void err;
    }
  }

  statusFor(monitor: Monitor, now: Date = new Date()): MonitorStatus {
    const last24h = this.checksForRange(monitor.id, 1, now);
    const last90d = this.checksForRange(monitor.id, 90, now);
    const last = this.lastCheck(monitor.id);

    const uptime24h = summarise(last24h).pct;

    // a paused monitor keeps its history but publishes no live state
    let state: MonitorStatus['state'] = 'nodata';
    if (monitor.active && last) {
      state = last.ok ? stateForPct(uptime24h) : 'down';
    }

    return {
      monitor,
      lastCheck: last,
      state,
      uptime24h,
      uptime90d: summarise(last90d).pct,
      avgLatencyMs24h: averageLatency(last24h),
      openIncident: this.openIncident(monitor.id)
    };
  }

  allStatuses(now: Date = new Date()): MonitorStatus[] {
    return this.list().map((m) => this.statusFor(m, now));
  }

  summary(now: Date = new Date()): {
    state: 'up' | 'degraded' | 'down' | 'nodata';
    monitors: number;
    up: number;
    degraded: number;
    down: number;
    openIncidents: number;
    uptime90d: number | null;
  } {
    const statuses = this.allStatuses(now);
    const counts = { up: 0, degraded: 0, down: 0, nodata: 0 };
    for (const s of statuses) counts[s.state] += 1;

    const all90 = statuses.map((s) => s.uptime90d);
    const withData = all90.filter((v): v is number => v !== null);

    return {
      state: worstState(statuses.map((s) => s.state)),
      monitors: statuses.length,
      up: counts.up,
      degraded: counts.degraded,
      down: counts.down,
      openIncidents: statuses.filter((s) => s.openIncident).length,
      // fleet uptime is the mean of each monitor's own 90-day uptime, so a
      // monitor with thousands of checks cannot outvote one with a few
      uptime90d: withData.length
        ? round2(withData.reduce((a, b) => a + b, 0) / withData.length)
        : null
    };
  }

  bucketsFor(monitorId: number, days: number, now: Date = new Date()) {
    return dailyBuckets(this.checksForRange(monitorId, days, now), days, now);
  }
}

/** Run one monitor's check and persist the result. */
export async function runMonitorCheck(
  store: MonitorStore,
  monitor: Monitor,
  fetchImpl?: FetchLike,
  now: Date = new Date()
): Promise<Check> {
  const result = await checkMonitor(monitor, fetchImpl);
  return store.recordCheck(monitor.id, result, now);
}
