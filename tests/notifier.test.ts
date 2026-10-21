import { describe, expect, it, vi } from 'vitest';
import { createWebhookNotifier, type IncidentEvent } from '../src/core/notifier.js';

const opened: IncidentEvent = {
  event: 'incident.opened',
  monitorId: 1,
  monitorName: 'API',
  url: 'https://api.test/health',
  at: '2026-03-01T00:00:00.000Z',
  reason: 'expected 200, got 503'
};

const resolved: IncidentEvent = {
  event: 'incident.resolved',
  monitorId: 1,
  monitorName: 'API',
  url: 'https://api.test/health',
  at: '2026-03-01T00:05:00.000Z',
  durationS: 300
};

function recorder() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe('createWebhookNotifier', () => {
  it('posts the event as JSON to the configured url', async () => {
    const { calls, impl } = recorder();
    const notify = createWebhookNotifier({ url: 'https://hooks.test/x', fetchImpl: impl });
    notify(opened);
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://hooks.test/x');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(opened);
  });

  it('returns immediately instead of waiting for delivery', async () => {
    let release: (() => void) | null = null;
    const slow = (async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const notify = createWebhookNotifier({ url: 'https://hooks.test/x', fetchImpl: slow });
    const started = Date.now();
    notify(opened);
    expect(Date.now() - started).toBeLessThan(50); // did not await
    release?.();
    await flush();
  });

  it('retries a rejected delivery and gives up after the attempt budget', async () => {
    const calls: number[] = [];
    const failing = (async () => {
      calls.push(1);
      return new Response('nope', { status: 500 });
    }) as unknown as typeof fetch;

    const sleeps: number[] = [];
    const notify = createWebhookNotifier({
      url: 'https://hooks.test/x',
      fetchImpl: failing,
      attempts: 3,
      backoffMs: 10,
      sleep: async (ms) => { sleeps.push(ms); }
    });

    notify(opened);
    await flush();

    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([10, 20]); // exponential backoff
  });

  it('stops retrying as soon as one attempt succeeds', async () => {
    let n = 0;
    const flaky = (async () => {
      n += 1;
      return new Response('', { status: n < 2 ? 503 : 200 });
    }) as unknown as typeof fetch;

    const notify = createWebhookNotifier({
      url: 'https://hooks.test/x',
      fetchImpl: flaky,
      attempts: 5,
      backoffMs: 5,
      sleep: async () => {}
    });

    notify(opened);
    await flush();
    expect(n).toBe(2);
  });

  it('survives a webhook that throws', async () => {
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const logs: string[] = [];
    const notify = createWebhookNotifier({
      url: 'https://hooks.test/x',
      fetchImpl: boom,
      attempts: 2,
      backoffMs: 1,
      sleep: async () => {},
      log: (m) => logs.push(m)
    });

    expect(() => notify(opened)).not.toThrow();
    await flush();
    expect(logs.filter((l) => l === 'webhook delivery failed')).toHaveLength(2);
  });

  it('delivers a resolution event with its duration', async () => {
    const { calls, impl } = recorder();
    const notify = createWebhookNotifier({ url: 'https://hooks.test/x', fetchImpl: impl });
    notify(resolved);
    await flush();
    expect(JSON.parse(String(calls[0]!.init.body)).durationS).toBe(300);
  });
});
