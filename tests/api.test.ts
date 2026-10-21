import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../src/db/index.js';
import { buildApp } from '../src/app.js';

let db: Database.Database;
let app: FastifyInstance;

async function makeApp(adminToken?: string) {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const built = await buildApp({ db, adminToken });
  app = built.app;
  await app.ready();
  return built;
}

beforeEach(async () => {
  await makeApp();
});

afterEach(async () => {
  await app.close();
  db.close();
});

describe('GET /api/health', () => {
  it('reports ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

describe('GET /api/summary', () => {
  it('is safe on an empty database', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/summary' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.monitors).toBe(0);
    expect(body.state).toBe('nodata');
    expect(body.incidents).toEqual([]);
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
  });
});

describe('POST /api/monitors', () => {
  it('creates a monitor and returns its status', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/monitors',
      payload: { name: 'API', url: 'https://example.com/health' }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.monitor.name).toBe('API');
    expect(body.monitor.intervalS).toBe(60);
    expect(body.state).toBe('nodata');
  });

  it('rejects an invalid payload with field-level errors', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/monitors', payload: { name: '', url: 'nope' } });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe('validation failed');
    expect(body.errors.map((e: { field: string }) => e.field)).toEqual(['name', 'url']);
  });

  it('rejects an empty body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/monitors' });
    expect(res.statusCode).toBe(422);
  });
});

describe('GET /api/monitors', () => {
  it('returns statuses for every monitor', async () => {
    await app.inject({ method: 'POST', url: '/api/monitors', payload: { name: 'a', url: 'https://a.test' } });
    await app.inject({ method: 'POST', url: '/api/monitors', payload: { name: 'b', url: 'https://b.test' } });
    const res = await app.inject({ method: 'GET', url: '/api/monitors' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    expect(body[0].state).toBe('nodata');
    expect(body[0].monitor.name).toBe('a');
  });
});

describe('GET /api/monitors/:id', () => {
  it('404s for a missing monitor', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/monitors/999' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('monitor not found');
  });
});

describe('history', () => {
  it('emits a fixed number of buckets with a recent check list', async () => {
    const created = (
      await app.inject({ method: 'POST', url: '/api/monitors', payload: { name: 'a', url: 'https://a.test' } })
    ).json();
    const id = created.monitor.id;

    const res = await app.inject({ method: 'GET', url: `/api/monitors/${id}/history?days=14` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.days).toBe(14);
    expect(body.buckets).toHaveLength(14);
    expect(body.recent).toEqual([]);
  });

  it('clamps the days query into a sane range', async () => {
    const created = (
      await app.inject({ method: 'POST', url: '/api/monitors', payload: { name: 'a', url: 'https://a.test' } })
    ).json();
    const id = created.monitor.id;

    const high = (await app.inject({ method: 'GET', url: `/api/monitors/${id}/history?days=9999` })).json();
    expect(high.days).toBe(365);
    expect(high.buckets).toHaveLength(365);

    const low = (await app.inject({ method: 'GET', url: `/api/monitors/${id}/history?days=0` })).json();
    expect(low.days).toBe(1);
  });

  it('404s for a missing monitor', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/monitors/404/history' });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/monitors/:id', () => {
  it('pauses a monitor', async () => {
    const created = (
      await app.inject({ method: 'POST', url: '/api/monitors', payload: { name: 'a', url: 'https://a.test' } })
    ).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/monitors/${created.monitor.id}`,
      payload: { active: false }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().monitor.active).toBe(false);
  });

  it('validates only the fields present in the patch', async () => {
    const created = (
      await app.inject({ method: 'POST', url: '/api/monitors', payload: { name: 'a', url: 'https://a.test' } })
    ).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/monitors/${created.monitor.id}`,
      payload: { active: false }
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a bad url in the patch', async () => {
    const created = (
      await app.inject({ method: 'POST', url: '/api/monitors', payload: { name: 'a', url: 'https://a.test' } })
    ).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/monitors/${created.monitor.id}`,
      payload: { url: 'gopher://nope' }
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0].field).toBe('url');
  });

  it('404s for a missing monitor', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/monitors/999', payload: { name: 'x' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/monitors/:id', () => {
  it('deletes and returns 204', async () => {
    const created = (
      await app.inject({ method: 'POST', url: '/api/monitors', payload: { name: 'a', url: 'https://a.test' } })
    ).json();
    const res = await app.inject({ method: 'DELETE', url: `/api/monitors/${created.monitor.id}` });
    expect(res.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/monitors' })).json()).toEqual([]);
  });

  it('404s for a missing monitor', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/monitors/999' });
    expect(res.statusCode).toBe(404);
  });
});

describe('bodyless mutations', () => {
  it('accepts a check-now POST with no body and no content-type', async () => {
    const created = (
      await app.inject({ method: 'POST', url: '/api/monitors', payload: { name: 'a', url: 'https://a.test' } })
    ).json();
    const res = await app.inject({ method: 'POST', url: `/api/monitors/${created.monitor.id}/check` });
    // the probe itself may fail (example.test does not resolve) but the request is valid
    expect(res.statusCode).toBe(200);
    expect(res.json().check).toHaveProperty('ok');
  });

  it('rejects an empty body that claims to be JSON (why the client omits the header)', async () => {
    const created = (
      await app.inject({ method: 'POST', url: '/api/monitors', payload: { name: 'a', url: 'https://a.test' } })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/monitors/${created.monitor.id}/check`,
      headers: { 'content-type': 'application/json' }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('admin token', () => {
  it('rejects mutations without the token when one is configured', async () => {
    await app.close();
    await makeApp('s3cret');

    const res = await app.inject({
      method: 'POST',
      url: '/api/monitors',
      payload: { name: 'a', url: 'https://a.test' }
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts mutations with the right token', async () => {
    await app.close();
    await makeApp('s3cret');

    const res = await app.inject({
      method: 'POST',
      url: '/api/monitors',
      payload: { name: 'a', url: 'https://a.test' },
      headers: { 'x-admin-token': 's3cret' }
    });
    expect(res.statusCode).toBe(201);
  });

  it('leaves reads public', async () => {
    await app.close();
    await makeApp('s3cret');
    expect((await app.inject({ method: 'GET', url: '/api/monitors' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/summary' })).statusCode).toBe(200);
  });
});

describe('webhook wiring', () => {
  it('fires a webhook when a check opens an incident, end to end through the API', async () => {
    await app.close();
    const db2 = new Database(':memory:');
    db2.pragma('foreign_keys = ON');
    runMigrations(db2);

    const received: Array<Record<string, unknown>> = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      received.push(JSON.parse(String(init.body)));
      return new Response('', { status: 204 });
    }) as unknown as typeof fetch;

    const built = await buildApp({ db: db2, webhookUrl: 'https://hooks.test/pulse', webhookFetch: fakeFetch });
    app = built.app;
    await app.ready();

    // point the monitor at a closed port so the probe genuinely fails
    built.store.create({ name: 'Dead service', url: 'http://127.0.0.1:1/nothing' });
    const id = built.store.list()[0]!.id;
    await app.inject({ method: 'POST', url: `/api/monitors/${id}/check` });
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    expect(received[0]!.event).toBe('incident.opened');
    expect(received[0]!.monitorName).toBe('Dead service');
    expect(String(received[0]!.reason)).toContain('fetch failed');
  });
});

describe('static pages', () => {
  it('serves the dashboard at /', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Pulse');
  });

  it('serves the public status page at /status', async () => {
    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('System Status');
  });

  it('serves the stylesheet and scripts', async () => {
    for (const path of ['/style.css', '/app.js', '/status.js']) {
      const res = await app.inject({ method: 'GET', url: path });
      expect(res.statusCode, path).toBe(200);
    }
  });
});
