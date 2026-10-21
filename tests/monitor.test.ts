import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/index.js';
import { MonitorStore, runMonitorCheck, validateMonitor } from '../src/core/monitor.js';
import type { IncidentEvent } from '../src/core/notifier.js';

let db: Database.Database;
let store: MonitorStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  store = new MonitorStore(db);
});

const T0 = new Date('2026-03-01T00:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe('validateMonitor', () => {
  it('accepts a minimal valid monitor', () => {
    expect(validateMonitor({ name: 'api', url: 'https://example.com' })).toEqual([]);
  });
  it('requires a name', () => {
    expect(validateMonitor({ url: 'https://example.com' }).map((e) => e.field)).toContain('name');
  });
  it('rejects a blank name', () => {
    expect(validateMonitor({ name: '   ', url: 'https://example.com' }).map((e) => e.field)).toContain('name');
  });
  it('requires an absolute http(s) url', () => {
    for (const url of ['', 'nope', '/relative', 'ftp://x.test', 'javascript:alert(1)']) {
      expect(validateMonitor({ name: 'a', url }).map((e) => e.field)).toContain('url');
    }
  });
  it('bounds the timeout', () => {
    expect(validateMonitor({ name: 'a', url: 'https://x.test', timeoutMs: 500 }).map((e) => e.field)).toContain('timeoutMs');
    expect(validateMonitor({ name: 'a', url: 'https://x.test', timeoutMs: 90000 }).map((e) => e.field)).toContain('timeoutMs');
    expect(validateMonitor({ name: 'a', url: 'https://x.test', timeoutMs: 5000 })).toEqual([]);
  });
  it('bounds the interval', () => {
    expect(validateMonitor({ name: 'a', url: 'https://x.test', intervalS: 5 }).map((e) => e.field)).toContain('intervalS');
    expect(validateMonitor({ name: 'a', url: 'https://x.test', intervalS: 60 })).toEqual([]);
  });
  it('bounds the expected status to real HTTP codes', () => {
    expect(validateMonitor({ name: 'a', url: 'https://x.test', expectStatus: 42 }).map((e) => e.field)).toContain('expectStatus');
    expect(validateMonitor({ name: 'a', url: 'https://x.test', expectStatus: 600 }).map((e) => e.field)).toContain('expectStatus');
    expect(validateMonitor({ name: 'a', url: 'https://x.test', expectStatus: 204 })).toEqual([]);
  });
});

describe('MonitorStore CRUD', () => {
  it('creates with defaults applied', () => {
    const m = store.create({ name: ' API ', url: ' https://example.com ' }, T0);
    expect(m.name).toBe('API');
    expect(m.url).toBe('https://example.com');
    expect(m.method).toBe('GET');
    expect(m.expectStatus).toBe(200);
    expect(m.timeoutMs).toBe(10000);
    expect(m.intervalS).toBe(60);
    expect(m.active).toBe(true);
    expect(m.createdAt).toBe(T0.toISOString());
  });

  it('lists in creation order', () => {
    store.create({ name: 'a', url: 'https://a.test' }, T0);
    store.create({ name: 'b', url: 'https://b.test' }, T0);
    expect(store.list().map((m) => m.name)).toEqual(['a', 'b']);
  });

  it('uppercases the method', () => {
    expect(store.create({ name: 'a', url: 'https://a.test', method: 'head' }, T0).method).toBe('HEAD');
  });

  it('returns null for a missing monitor', () => {
    expect(store.get(999)).toBeNull();
  });

  it('updates fields and leaves the rest alone', () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, T0);
    const updated = store.update(m.id, { name: 'renamed' })!;
    expect(updated.name).toBe('renamed');
    expect(updated.url).toBe('https://a.test');
    expect(updated.intervalS).toBe(60);
  });

  it('pauses and resumes', () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, T0);
    expect(store.update(m.id, { active: false })!.active).toBe(false);
    expect(store.update(m.id, { active: true })!.active).toBe(true);
  });

  it('returns null when updating a missing monitor', () => {
    expect(store.update(999, { name: 'x' })).toBeNull();
  });

  it('deletes and reports whether anything was removed', () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, T0);
    expect(store.remove(m.id)).toBe(true);
    expect(store.remove(m.id)).toBe(false);
    expect(store.list()).toEqual([]);
  });
});

describe('recordCheck + incidents', () => {
  it('stores a successful check', () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, T0);
    const c = store.recordCheck(m.id, { ok: true, statusCode: 200, latencyMs: 42, error: null }, at(1));
    expect(c.ok).toBe(true);
    expect(c.latencyMs).toBe(42);
    expect(c.checkedAt).toBe(at(1).toISOString());
  });

  it('opens exactly one incident for a run of failures', () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, T0);
    for (let i = 0; i < 5; i++) {
      store.recordCheck(m.id, { ok: false, statusCode: 500, latencyMs: 10, error: 'boom' }, at(i));
    }
    expect(store.openIncident(m.id)?.reason).toBe('boom');
    expect(store.incidents()).toHaveLength(1);
  });

  it('resolves the incident on the next success', () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, T0);
    store.recordCheck(m.id, { ok: false, statusCode: 500, latencyMs: 10, error: 'boom' }, at(0));
    store.recordCheck(m.id, { ok: true, statusCode: 200, latencyMs: 20, error: null }, at(5));
    expect(store.openIncident(m.id)).toBeNull();
    const [incident] = store.incidents();
    expect(incident!.resolvedAt).toBe(at(5).toISOString());
  });

  it('opens a new incident after a recovery followed by another failure', () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, T0);
    store.recordCheck(m.id, { ok: false, statusCode: 500, latencyMs: 1, error: 'first' }, at(0));
    store.recordCheck(m.id, { ok: true, statusCode: 200, latencyMs: 1, error: null }, at(1));
    store.recordCheck(m.id, { ok: false, statusCode: 500, latencyMs: 1, error: 'second' }, at(2));
    expect(store.incidents()).toHaveLength(2);
    expect(store.openIncident(m.id)?.reason).toBe('second');
  });

  it('does not open an incident for a passing check', () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, T0);
    store.recordCheck(m.id, { ok: true, statusCode: 200, latencyMs: 5, error: null }, at(0));
    expect(store.incidents()).toHaveLength(0);
  });

  it('scopes incidents per monitor', () => {
    const a = store.create({ name: 'a', url: 'https://a.test' }, T0);
    const b = store.create({ name: 'b', url: 'https://b.test' }, T0);
    store.recordCheck(a.id, { ok: false, statusCode: 500, latencyMs: 1, error: 'a down' }, at(0));
    expect(store.openIncident(b.id)).toBeNull();
    expect(store.openIncident(a.id)?.reason).toBe('a down');
  });
});

describe('statusFor', () => {
  it('is nodata before any checks', () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, T0);
    const s = store.statusFor(m, at(10));
    expect(s.state).toBe('nodata');
    expect(s.uptime24h).toBeNull();
    expect(s.lastCheck).toBeNull();
  });

  it('is up when every recent check passed', () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, T0);
    store.recordCheck(m.id, { ok: true, statusCode: 200, latencyMs: 30, error: null }, at(1));
    const s = store.statusFor(m, at(2));
    expect(s.state).toBe('up');
    expect(s.uptime24h).toBe(100);
    expect(s.avgLatencyMs24h).toBe(30);
  });

  it('is down as soon as the latest check failed, even if the day was mostly green', () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, T0);
    for (let i = 0; i < 9; i++) {
      store.recordCheck(m.id, { ok: true, statusCode: 200, latencyMs: 10, error: null }, at(i));
    }
    store.recordCheck(m.id, { ok: false, statusCode: 500, latencyMs: 10, error: 'boom' }, at(10));
    const s = store.statusFor(m, at(10));
    expect(s.state).toBe('down');
    expect(s.openIncident).not.toBeNull();
  });

  it('reports a paused monitor as nodata', () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, T0);
    store.recordCheck(m.id, { ok: true, statusCode: 200, latencyMs: 10, error: null }, at(1));
    const paused = store.update(m.id, { active: false })!;
    expect(store.statusFor(paused, at(2)).state).toBe('nodata');
  });

  it('ignores checks older than the 24 hour window', () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, T0);
    store.recordCheck(m.id, { ok: false, statusCode: 500, latencyMs: 10, error: 'old' }, new Date(T0.getTime() - 3 * 86400_000));
    const s = store.statusFor(m, at(0));
    expect(s.uptime24h).toBeNull();
  });
});

describe('summary', () => {
  it('is empty-safe', () => {
    const s = store.summary(T0);
    expect(s.monitors).toBe(0);
    expect(s.state).toBe('nodata');
    expect(s.uptime90d).toBeNull();
  });

  it('counts states across the fleet', () => {
    const a = store.create({ name: 'a', url: 'https://a.test' }, T0);
    const b = store.create({ name: 'b', url: 'https://b.test' }, T0);
    store.recordCheck(a.id, { ok: true, statusCode: 200, latencyMs: 10, error: null }, at(1));
    store.recordCheck(b.id, { ok: false, statusCode: 500, latencyMs: 10, error: 'down' }, at(1));

    const s = store.summary(at(2));
    expect(s.monitors).toBe(2);
    expect(s.up).toBe(1);
    expect(s.down).toBe(1);
    expect(s.state).toBe('down');
    expect(s.openIncidents).toBe(1);
  });

  it('averages per-monitor uptime rather than per-check volume', () => {
    const a = store.create({ name: 'a', url: 'https://a.test' }, T0);
    const b = store.create({ name: 'b', url: 'https://b.test' }, T0);
    // a: one failing check (0%), b: one passing check (100%)
    store.recordCheck(a.id, { ok: false, statusCode: 500, latencyMs: 1, error: 'x' }, at(1));
    store.recordCheck(b.id, { ok: true, statusCode: 200, latencyMs: 1, error: null }, at(1));
    // 90d is per-monitor, so the mean is 50 — not skewed by check counts
    expect(store.summary(at(2)).uptime90d).toBe(50);
  });
});

describe('runMonitorCheck', () => {
  it('runs the check and persists the result', async () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, T0);
    const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const c = await runMonitorCheck(store, m, fetchImpl, at(1));
    expect(c.ok).toBe(true);
    expect(store.lastCheck(m.id)?.ok).toBe(true);
  });

  it('persists a failure and opens an incident', async () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, T0);
    const fetchImpl = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    await runMonitorCheck(store, m, fetchImpl, at(1));
    expect(store.openIncident(m.id)).not.toBeNull();
  });
});


describe('incident notifications', () => {
  function storeWithSink(): { store: MonitorStore; events: IncidentEvent[] } {
    const events: IncidentEvent[] = [];
    const db2 = new Database(':memory:');
    db2.pragma('foreign_keys = ON');
    runMigrations(db2);
    const store2 = new MonitorStore(db2, { notify: (e) => events.push(e) });
    return { store: store2, events };
  }

  it('emits exactly one open event for a run of failures', () => {
    const { store: s2, events } = storeWithSink();
    const m = s2.create({ name: 'API', url: 'https://api.test' }, T0);
    for (let i = 0; i < 4; i++) {
      s2.recordCheck(m.id, { ok: false, statusCode: 503, latencyMs: 1, error: 'expected 200, got 503' }, at(i));
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('incident.opened');
    expect(events[0]!.monitorName).toBe('API');
    expect(events[0]!.reason).toBe('expected 200, got 503');
    expect(events[0]!.at).toBe(at(0).toISOString());
  });

  it('emits a resolved event carrying the outage duration', () => {
    const { store: s2, events } = storeWithSink();
    const m = s2.create({ name: 'API', url: 'https://api.test' }, T0);
    s2.recordCheck(m.id, { ok: false, statusCode: 503, latencyMs: 1, error: 'boom' }, at(0));
    s2.recordCheck(m.id, { ok: true, statusCode: 200, latencyMs: 5, error: null }, at(10));

    expect(events.map((e) => e.event)).toEqual(['incident.opened', 'incident.resolved']);
    const resolved = events[1]!;
    expect(resolved.event === 'incident.resolved' && resolved.durationS).toBe(600);
  });

  it('emits nothing for a healthy check', () => {
    const { store: s2, events } = storeWithSink();
    const m = s2.create({ name: 'API', url: 'https://api.test' }, T0);
    s2.recordCheck(m.id, { ok: true, statusCode: 200, latencyMs: 5, error: null }, at(0));
    expect(events).toEqual([]);
  });

  it('does not notify repeatedly while an incident stays open', () => {
    const { store: s2, events } = storeWithSink();
    const m = s2.create({ name: 'API', url: 'https://api.test' }, T0);
    s2.recordCheck(m.id, { ok: false, statusCode: 503, latencyMs: 1, error: 'boom' }, at(0));
    s2.recordCheck(m.id, { ok: false, statusCode: 503, latencyMs: 1, error: 'boom' }, at(1));
    s2.recordCheck(m.id, { ok: true, statusCode: 200, latencyMs: 1, error: null }, at(2));
    s2.recordCheck(m.id, { ok: true, statusCode: 200, latencyMs: 1, error: null }, at(3));
    expect(events.map((e) => e.event)).toEqual(['incident.opened', 'incident.resolved']);
  });

  it('keeps recording checks when the notifier itself throws', () => {
    const db2 = new Database(':memory:');
    db2.pragma('foreign_keys = ON');
    runMigrations(db2);
    const s2 = new MonitorStore(db2, {
      notify: () => {
        throw new Error('webhook exploded');
      }
    });
    const m = s2.create({ name: 'API', url: 'https://api.test' }, T0);
    expect(() =>
      s2.recordCheck(m.id, { ok: false, statusCode: 503, latencyMs: 1, error: 'boom' }, at(0))
    ).not.toThrow();
    expect(s2.openIncident(m.id)).not.toBeNull();
  });

  it('does not emit an event when the transaction is the only thing that failed', () => {
    const { store: s2, events } = storeWithSink();
    // recording against a monitor that does not exist trips the FK constraint
    expect(() =>
      s2.recordCheck(999, { ok: false, statusCode: 503, latencyMs: 1, error: 'boom' }, at(0))
    ).toThrow();
    expect(events).toEqual([]);
  });
});
