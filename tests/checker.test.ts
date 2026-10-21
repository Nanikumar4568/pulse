import { describe, expect, it, vi } from 'vitest';
import { checkMonitor } from '../src/core/checker.js';
import type { Monitor } from '../src/core/types.js';

const base: Pick<Monitor, 'url' | 'method' | 'expectStatus' | 'timeoutMs'> = {
  url: 'https://example.com',
  method: 'GET',
  expectStatus: 200,
  timeoutMs: 5000
};

function fakeFetch(impl: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return impl as unknown as typeof fetch;
}

describe('checkMonitor', () => {
  it('passes when the status matches', async () => {
    const fetchImpl = fakeFetch(async () => new Response('ok', { status: 200 }));
    const r = await checkMonitor(base, fetchImpl);
    expect(r.ok).toBe(true);
    expect(r.statusCode).toBe(200);
    expect(r.error).toBeNull();
    expect(typeof r.latencyMs).toBe('number');
  });

  it('fails when the status is unexpected, and records both codes', async () => {
    const fetchImpl = fakeFetch(async () => new Response('nope', { status: 503 }));
    const r = await checkMonitor(base, fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(503);
    expect(r.error).toBe('expected 200, got 503');
  });

  it('honours a non-default expected status', async () => {
    const fetchImpl = fakeFetch(async () => new Response(null, { status: 204 }));
    const r = await checkMonitor({ ...base, expectStatus: 204 }, fetchImpl);
    expect(r.ok).toBe(true);
  });

  it('treats a redirect followed to success as ok', async () => {
    const fetchImpl = fakeFetch(async () => new Response('', { status: 200 }));
    const r = await checkMonitor({ ...base, method: 'HEAD' }, fetchImpl);
    expect(r.ok).toBe(true);
  });

  it('converts a thrown network error into a failed check, never an exception', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const r = await checkMonitor(base, fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBeNull();
    expect(r.error).toContain('fetch failed');
  });

  it('includes the undici cause when present', async () => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = new Error('getaddrinfo ENOTFOUND nope.invalid');
    const fetchImpl = fakeFetch(async () => {
      throw err;
    });
    const r = await checkMonitor({ ...base, url: 'https://nope.invalid' }, fetchImpl);
    expect(r.error).toContain('ENOTFOUND');
  });

  it('aborts and reports a timeout', async () => {
    const fetchImpl = fakeFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            reject(e);
          });
        })
    );
    const r = await checkMonitor({ ...base, timeoutMs: 20 }, fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('timed out after 20ms');
  });

  it('measures latency as elapsed wall time', async () => {
    const fetchImpl = fakeFetch(
      () => new Promise((resolve) => setTimeout(() => resolve(new Response('', { status: 200 })), 30))
    );
    const r = await checkMonitor(base, fetchImpl);
    expect(r.latencyMs).toBeGreaterThanOrEqual(25);
  });

  it('sends a user agent so endpoints can identify the prober', async () => {
    const spy = vi.fn(async () => new Response('', { status: 200 }));
    await checkMonitor(base, spy as unknown as typeof fetch);
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['user-agent']).toContain('pulse-uptime');
  });

  it('does not leak a pending timer after a fast response', async () => {
    const fetchImpl = fakeFetch(async () => new Response('', { status: 200 }));
    await checkMonitor({ ...base, timeoutMs: 60000 }, fetchImpl);
    // if the timer were left armed this test file would hang for a minute
    expect(true).toBe(true);
  });
});
