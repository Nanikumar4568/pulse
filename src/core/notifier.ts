/**
 * Webhook alerts.
 *
 * Failures and recoveries are delivered as a POST to a URL you configure. The
 * notifier is deliberately fire-and-forget: a slow or hostile webhook must never
 * slow down the scheduler or fail a check. Delivery is retried a couple of times
 * with backoff, and every attempt is bounded by its own timeout.
 */
import type { FetchLike } from './checker.js';

export type IncidentEvent =
  | {
      event: 'incident.opened';
      monitorId: number;
      monitorName: string;
      url: string;
      at: string;
      reason: string;
    }
  | {
      event: 'incident.resolved';
      monitorId: number;
      monitorName: string;
      url: string;
      at: string;
      /** how long the incident was open, in seconds */
      durationS: number;
    };

export type Notifier = (event: IncidentEvent) => void;

export interface WebhookOptions {
  url: string;
  /** attempts per event, including the first */
  attempts?: number;
  timeoutMs?: number;
  /** base delay between attempts; doubles each time */
  backoffMs?: number;
  fetchImpl?: FetchLike;
  log?: (msg: string, meta?: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Build a notifier that POSTs each event as JSON. Returns a function that
 * queues delivery in the background and never rejects.
 */
export function createWebhookNotifier(opts: WebhookOptions): Notifier {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const backoffMs = opts.backoffMs ?? 250;
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? defaultSleep;
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as FetchLike);

  async function deliver(event: IncidentEvent): Promise<boolean> {
    const body = JSON.stringify(event);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await doFetch(opts.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'pulse-uptime/1.0' },
          body,
          signal: AbortSignal.timeout(timeoutMs)
        });
        // drain so the socket can be reused
        await res.text().catch(() => '');

        if (res.status >= 200 && res.status < 300) return true;

        log('webhook rejected', { status: res.status, attempt, event: event.event });
      } catch (err) {
        log('webhook delivery failed', { attempt, event: event.event, error: String(err) });
      }

      if (attempt < attempts) await sleep(backoffMs * 2 ** (attempt - 1));
    }
    return false;
  }

  return (event) => {
    // intentionally not awaited: delivery must never block a check
    void deliver(event).catch((err) => log('webhook crashed', { error: String(err) }));
  };
}

/** A notifier that does nothing, used when no webhook is configured. */
export const noopNotifier: Notifier = () => {};
