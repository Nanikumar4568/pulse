import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/index.js';
import { MonitorStore } from '../src/core/monitor.js';
import { createScheduler, isDue } from '../src/core/scheduler.js';

let db: Database.Database;
let store: MonitorStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  store = new MonitorStore(db);
});

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
}

describe('isDue', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');

  it('is due when never checked', () => {
    expect(isDue(null, 60, now)).toBe(true);
  });
  it('is not due before the interval elapses', () => {
    expect(isDue('2026-03-01T11:59:30.000Z', 60, now)).toBe(false);
  });
  it('is due exactly at the interval boundary', () => {
    expect(isDue('2026-03-01T11:59:00.000Z', 60, now)).toBe(true);
  });
  it('is due after the interval', () => {
    expect(isDue('2026-03-01T11:00:00.000Z', 60, now)).toBe(true);
  });
  it('treats an unparseable timestamp as due so a broken row self-heals', () => {
    expect(isDue('nonsense', 60, now)).toBe(true);
  });
});

describe('createScheduler', () => {
  it('checks an active monitor that has never been checked', async () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, new Date());
    const s = createScheduler({ store, fetchImpl: okFetch(), now: () => new Date() });
    await s.tick();
    expect(store.lastCheck(m.id)?.ok).toBe(true);
    expect(s.stats().checksRun).toBe(1);
  });

  it('skips a monitor whose interval has not elapsed', async () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const m = store.create({ name: 'a', url: 'https://a.test' }, now);
    store.recordCheck(m.id, { ok: true, statusCode: 200, latencyMs: 1, error: null }, now);

    const fetchImpl = okFetch();
    const s = createScheduler({ store, fetchImpl, now: () => new Date(now.getTime() + 1000) });
    await s.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(s.stats().checksRun).toBe(0);
  });

  it('checks again once the interval has elapsed', async () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const m = store.create({ name: 'a', url: 'https://a.test', intervalS: 60 }, now);
    store.recordCheck(m.id, { ok: true, statusCode: 200, latencyMs: 1, error: null }, now);

    const s = createScheduler({
      store,
      fetchImpl: okFetch(),
      now: () => new Date(now.getTime() + 61_000)
    });
    await s.tick();
    expect(store.checksFor(m.id)).toHaveLength(2);
    expect(s.stats().checksRun).toBe(1);
  });

  it('never checks a paused monitor', async () => {
    const m = store.create({ name: 'a', url: 'https://a.test' }, new Date());
    store.update(m.id, { active: false });
    const fetchImpl = okFetch();
    const s = createScheduler({ store, fetchImpl, now: () => new Date() });
    await s.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('checks the whole fleet in one pass', async () => {
    for (const n of ['a', 'b', 'c']) {
      store.create({ name: n, url: 'https://' + n + '.test' }, new Date());
    }
    const s = createScheduler({ store, fetchImpl: okFetch(), now: () => new Date() });
    await s.tick();
    expect(s.stats().checksRun).toBe(3);
  });

  it('records a network blow-up as a failed check, not a crashed scheduler', async () => {
    const a = store.create({ name: 'a', url: 'https://a.test' }, new Date());
    const b = store.create({ name: 'b', url: 'https://b.test' }, new Date());

    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response('', { status: 200 });
    });

    const errors: string[] = [];
    const s = createScheduler({
      store,
      fetchImpl: flaky as unknown as typeof fetch,
      now: () => new Date(),
      log: (msg) => errors.push(msg)
    });

    await s.tick();
    // the checker swallows transport errors into a result, so both monitors completed
    expect(s.stats().checksRun).toBe(2);
    expect(errors).toEqual([]);
    const failed = store.list().filter((m) => store.lastCheck(m.id)?.ok === false);
    expect(failed.length).toBe(1);
    expect(store.openIncident(failed[0]!.id)).not.toBeNull();
    expect(store.list().filter((m) => store.lastCheck(m.id)?.ok === true).length).toBe(1);
    // every monitor got exactly one row
    expect(store.checksFor(a.id)).toHaveLength(1);
    expect(store.checksFor(b.id)).toHaveLength(1);
  });

  it('isolates a persisted-storage failure so one bad row cannot stop the pass', async () => {
    store.create({ name: 'a', url: 'https://a.test' }, new Date());
    store.create({ name: 'b', url: 'https://b.test' }, new Date());

    const realRecord = store.recordCheck.bind(store);
    let first = true;
    vi.spyOn(store, 'recordCheck').mockImplementation((id, result, now) => {
      if (first) {
        first = false;
        throw new Error('disk gone');
      }
      return realRecord(id, result, now);
    });

    const errors: string[] = [];
    const s = createScheduler({
      store,
      fetchImpl: okFetch(),
      now: () => new Date(),
      log: (msg) => errors.push(msg)
    });

    await s.tick();
    expect(s.stats().checksRun).toBe(1);
    expect(s.stats().failures).toBe(1);
    expect(errors).toEqual(['check crashed']);
    expect(s.stats().inFlight).toBe(false);
  });

  it('does not overlap ticks', async () => {
    store.create({ name: 'a', url: 'https://a.test' }, new Date());
    let started = 0;
    const slow = vi.fn(() => {
      started += 1;
      return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('', { status: 200 })), 50));
    });

    const s = createScheduler({ store, fetchImpl: slow as unknown as typeof fetch, now: () => new Date() });
    const first = s.tick();
    const second = s.tick(); // must return immediately without starting work
    await Promise.all([first, second]);
    expect(started).toBe(1);
  });

  it('start() runs an immediate pass and stop() clears the timer', async () => {
    vi.useFakeTimers();
    try {
      store.create({ name: 'a', url: 'https://a.test' }, new Date());
      const s = createScheduler({ store, fetchImpl: okFetch(), tickMs: 1000, now: () => new Date() });
      s.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.stats().ticks).toBe(1);
      s.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(s.stats().ticks).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
