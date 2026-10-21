import type { FetchLike } from './checker.js';
import { runMonitorCheck, type MonitorStore } from './monitor.js';

export interface SchedulerOptions {
  store: MonitorStore;
  /** How often the scheduler wakes up to look for due monitors. */
  tickMs?: number;
  fetchImpl?: FetchLike;
  now?: () => Date;
  log?: (msg: string, meta?: unknown) => void;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  /** Run one pass immediately. Exposed so tests don't have to wait on timers. */
  tick(): Promise<void>;
  stats(): { ticks: number; checksRun: number; failures: number; inFlight: boolean };
}

/**
 * A monitor is due when it has never been checked, or when its own interval
 * has elapsed since the last check. One slow monitor must not delay the rest,
 * so due monitors are checked in parallel and failures are isolated.
 */
export function isDue(
  lastCheckedAt: string | null,
  intervalS: number,
  now: Date
): boolean {
  if (!lastCheckedAt) return true;
  const last = Date.parse(lastCheckedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= intervalS * 1000;
}

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const { store } = opts;
  const tickMs = opts.tickMs ?? 5000;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});

  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  const stats = { ticks: 0, checksRun: 0, failures: 0, inFlight: false };

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    stats.inFlight = true;

    try {
      const at = now();
      const due = store.list().filter((m) => {
        if (!m.active) return false;
        const last = store.lastCheck(m.id);
        return isDue(last?.checkedAt ?? null, m.intervalS, at);
      });

      stats.ticks += 1;
      if (due.length === 0) return;

      const results = await Promise.allSettled(
        due.map((m) => runMonitorCheck(store, m, opts.fetchImpl, at))
      );

      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (r.status === 'fulfilled') {
          stats.checksRun += 1;
        } else {
          stats.failures += 1;
          log('check crashed', { monitor: due[i]!.id, error: String(r.reason) });
        }
      }
    } finally {
      inFlight = false;
      stats.inFlight = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, tickMs);
      // don't hold the process open just for the scheduler
      timer.unref?.();
      void tick();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
    stats: () => ({ ...stats })
  };
}
