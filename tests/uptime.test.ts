import { describe, expect, it } from 'vitest';
import {
  averageLatency,
  dailyBuckets,
  dayKey,
  parseTargetUrl,
  round2,
  stateForPct,
  summarise,
  worstState
} from '../src/core/uptime.js';
import type { Check } from '../src/core/types.js';

function check(partial: Partial<Check>): Check {
  return {
    id: 0,
    monitorId: 1,
    checkedAt: '2026-01-01T00:00:00.000Z',
    ok: true,
    statusCode: 200,
    latencyMs: 100,
    error: null,
    ...partial
  };
}

describe('stateForPct', () => {
  it('treats no data as nodata', () => {
    expect(stateForPct(null)).toBe('nodata');
  });
  it('calls 100% up', () => {
    expect(stateForPct(100)).toBe('up');
  });
  it('keeps the boundary at 99.5 inclusive', () => {
    expect(stateForPct(99.5)).toBe('up');
    expect(stateForPct(99.49)).toBe('degraded');
  });
  it('keeps the boundary at 90 inclusive', () => {
    expect(stateForPct(90)).toBe('degraded');
    expect(stateForPct(89.99)).toBe('down');
  });
  it('calls 0% down', () => {
    expect(stateForPct(0)).toBe('down');
  });
});

describe('summarise', () => {
  it('returns null pct for an empty list rather than dividing by zero', () => {
    expect(summarise([])).toEqual({ total: 0, ok: 0, pct: null });
  });
  it('counts only successful checks', () => {
    const checks = [check({ ok: true }), check({ ok: false }), check({ ok: true }), check({ ok: true })];
    expect(summarise(checks)).toEqual({ total: 4, ok: 3, pct: 75 });
  });
  it('rounds to two decimals', () => {
    const checks = Array.from({ length: 3 }, (_, i) => check({ ok: i === 0 }));
    expect(summarise(checks).pct).toBe(33.33);
  });
  it('reports 100% when every check passed', () => {
    expect(summarise([check({}), check({})]).pct).toBe(100);
  });
});

describe('averageLatency', () => {
  it('ignores missing latencies', () => {
    expect(averageLatency([check({ latencyMs: 100 }), check({ latencyMs: null }), check({ latencyMs: 200 })])).toBe(150);
  });
  it('returns null when nothing has a latency', () => {
    expect(averageLatency([check({ latencyMs: null })])).toBeNull();
    expect(averageLatency([])).toBeNull();
  });
  it('rounds to a whole millisecond', () => {
    expect(averageLatency([check({ latencyMs: 101 }), check({ latencyMs: 100 })] )).toBe(101);
  });
});

describe('worstState', () => {
  it('lets one down monitor dominate', () => {
    expect(worstState(['up', 'up', 'down', 'up'])).toBe('down');
  });
  it('prefers degraded over up', () => {
    expect(worstState(['up', 'degraded'])).toBe('degraded');
  });
  it('is nodata only when there is nothing else', () => {
    expect(worstState(['nodata', 'nodata'])).toBe('nodata');
    expect(worstState(['nodata', 'up'])).toBe('up');
  });
  it('handles an empty fleet', () => {
    expect(worstState([])).toBe('nodata');
  });
});

describe('dailyBuckets', () => {
  const now = new Date('2026-03-10T12:00:00.000Z');

  it('emits exactly one bucket per requested day, oldest first', () => {
    const buckets = dailyBuckets([], 7, now);
    expect(buckets).toHaveLength(7);
    expect(buckets[0]!.date).toBe('2026-03-04');
    expect(buckets[6]!.date).toBe('2026-03-10');
  });

  it('marks days with no checks as nodata with a null pct', () => {
    const buckets = dailyBuckets([], 3, now);
    expect(buckets.every((b) => b.state === 'nodata')).toBe(true);
    expect(buckets.every((b) => b.pct === null)).toBe(true);
    expect(buckets.every((b) => b.total === 0)).toBe(true);
  });

  it('groups checks by UTC day', () => {
    const checks = [
      check({ checkedAt: '2026-03-10T01:00:00.000Z', ok: true }),
      check({ checkedAt: '2026-03-10T09:00:00.000Z', ok: false }),
      check({ checkedAt: '2026-03-09T23:30:00.000Z', ok: true })
    ];
    const buckets = dailyBuckets(checks, 3, now);
    const byDate = Object.fromEntries(buckets.map((b) => [b.date, b]));
    expect(byDate['2026-03-10']!.total).toBe(2);
    expect(byDate['2026-03-10']!.pct).toBe(50);
    expect(byDate['2026-03-10']!.state).toBe('down');
    expect(byDate['2026-03-09']!.total).toBe(1);
    expect(byDate['2026-03-09']!.pct).toBe(100);
    expect(byDate['2026-03-08']!.state).toBe('nodata');
  });

  it('computes a per-day average latency', () => {
    const checks = [
      check({ checkedAt: '2026-03-10T01:00:00.000Z', latencyMs: 100 }),
      check({ checkedAt: '2026-03-10T02:00:00.000Z', latencyMs: 300 })
    ];
    const buckets = dailyBuckets(checks, 1, now);
    expect(buckets[0]!.avgLatencyMs).toBe(200);
  });

  it('is timezone-stable: the day key never shifts', () => {
    // 00:30 UTC is the previous day in some zones; buckets must stay UTC
    const bucket = dailyBuckets([check({ checkedAt: '2026-03-10T00:30:00.000Z' })], 1, now)[0]!;
    expect(bucket.date).toBe('2026-03-10');
  });
});

describe('dayKey', () => {
  it('formats as YYYY-MM-DD in UTC', () => {
    expect(dayKey(new Date('2026-12-31T23:59:59.000Z'))).toBe('2026-12-31');
  });
});

describe('round2', () => {
  it('keeps two decimals', () => {
    expect(round2(1.23456)).toBe(1.23);
    expect(round2(33.333333)).toBe(33.33);
    expect(round2(99.999)).toBe(100);
    expect(round2(0)).toBe(0);
  });
});

describe('parseTargetUrl', () => {
  it('accepts http and https', () => {
    expect(parseTargetUrl('https://example.com/x')?.host).toBe('example.com');
    expect(parseTargetUrl('http://localhost:3000')?.protocol).toBe('http:');
  });
  it('rejects other protocols', () => {
    expect(parseTargetUrl('ftp://example.com')).toBeNull();
    expect(parseTargetUrl('file:///etc/passwd')).toBeNull();
    expect(parseTargetUrl('javascript:alert(1)')).toBeNull();
  });
  it('rejects garbage', () => {
    expect(parseTargetUrl('not a url')).toBeNull();
    expect(parseTargetUrl('')).toBeNull();
  });
});
