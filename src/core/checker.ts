import type { CheckResult, Monitor } from './types.js';

export type FetchLike = typeof fetch;

/**
 * Perform one HTTP check. Never throws: every failure mode becomes a
 * CheckResult, because a monitor that crashes the scheduler is worse than
 * a monitor that reports itself down.
 */
export async function checkMonitor(
  monitor: Pick<Monitor, 'url' | 'method' | 'expectStatus' | 'timeoutMs'>,
  fetchImpl: FetchLike = fetch
): Promise<CheckResult> {
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), monitor.timeoutMs);

  try {
    const res = await fetchImpl(monitor.url, {
      method: monitor.method,
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'pulse-uptime/1.0 (+https://github.com)' }
    });
    // Drain the body so the socket can be reused; we only care about status.
    await res.arrayBuffer().catch(() => undefined);
    const latencyMs = Date.now() - started;

    if (res.status !== monitor.expectStatus) {
      return {
        ok: false,
        statusCode: res.status,
        latencyMs,
        error: `expected ${monitor.expectStatus}, got ${res.status}`
      };
    }
    return { ok: true, statusCode: res.status, latencyMs, error: null };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      statusCode: null,
      latencyMs,
      error: aborted ? `timed out after ${monitor.timeoutMs}ms` : messageOf(err)
    };
  } finally {
    clearTimeout(timer);
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    // undici wraps the useful text in `cause`
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `${err.message}: ${cause.message}`;
    return err.message;
  }
  return String(err);
}
