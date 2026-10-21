import type { Check, DayBucket, DayState } from './types.js';

/** Thresholds used everywhere a percentage becomes a colour/state. */
export const UP_THRESHOLD = 99.5;
export const DEGRADED_THRESHOLD = 90;

export function stateForPct(pct: number | null): DayState {
  if (pct === null) return 'nodata';
  if (pct >= UP_THRESHOLD) return 'up';
  if (pct >= DEGRADED_THRESHOLD) return 'degraded';
  return 'down';
}

export interface UptimeSummary {
  total: number;
  ok: number;
  pct: number | null;
}

export function summarise(checks: Check[]): UptimeSummary {
  const total = checks.length;
  const ok = checks.reduce((n, c) => n + (c.ok ? 1 : 0), 0);
  return { total, ok, pct: total === 0 ? null : round2((ok / total) * 100) };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function averageLatency(checks: Check[]): number | null {
  const latencies = checks
    .map((c) => c.latencyMs)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  if (latencies.length === 0) return null;
  return Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
}

/** YYYY-MM-DD for a date, in UTC so buckets never shift with the host timezone. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Bucket checks into one row per day, oldest first, ending on `now`.
 * Days with no checks are emitted as `nodata` rather than silently skipped,
 * so the status page timeline always has a fixed width.
 */
export function dailyBuckets(checks: Check[], days: number, now: Date = new Date()): DayBucket[] {
  const byDay = new Map<string, Check[]>();
  for (const c of checks) {
    const key = c.checkedAt.slice(0, 10);
    const list = byDay.get(key);
    if (list) list.push(c);
    else byDay.set(key, [c]);
  }

  const out: DayBucket[] = [];
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - i);
    const key = dayKey(d);
    const dayChecks = byDay.get(key) ?? [];
    const sum = summarise(dayChecks);
    out.push({
      date: key,
      total: sum.total,
      ok: sum.ok,
      pct: sum.pct,
      state: stateForPct(sum.pct),
      avgLatencyMs: averageLatency(dayChecks)
    });
  }
  return out;
}

/**
 * The overall state of a group of monitors is the worst individual state:
 * one dead monitor must never be hidden by nine healthy ones.
 */
export function worstState(states: DayState[]): DayState {
  if (states.includes('down')) return 'down';
  if (states.includes('degraded')) return 'degraded';
  if (states.includes('up')) return 'up';
  return 'nodata';
}

/** Parse a URL, rejecting anything that isn't http(s). */
export function parseTargetUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url;
}
