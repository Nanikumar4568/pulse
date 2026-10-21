import type { FastifyInstance } from 'fastify';
import {
  MonitorStore,
  runMonitorCheck,
  validateMonitor,
  type CreateMonitorInput
} from '../core/monitor.js';
import { parseTargetUrl } from '../core/uptime.js';

export interface ApiOptions {
  store: MonitorStore;
  /** When set, mutating routes require `x-admin-token` to match. */
  adminToken?: string;
}

export function registerApi(app: FastifyInstance, opts: ApiOptions): void {
  const { store, adminToken } = opts;

  function requireAdmin(req: { headers: Record<string, unknown> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): boolean {
    if (!adminToken) return true; // open mode for local use
    const provided = req.headers['x-admin-token'];
    if (typeof provided === 'string' && provided === adminToken) return true;
    reply.code(401).send({ error: 'admin token required' });
    return false;
  }

  app.get('/api/health', async () => ({ ok: true, uptimeSeconds: Math.round(process.uptime()) }));

  // ---- public summary ----
  app.get('/api/summary', async () => {
    const s = store.summary();
    const incidents = store.incidents(10).map((i) => {
      const monitor = store.get(i.monitorId);
      return { ...i, monitorName: monitor?.name ?? 'removed monitor' };
    });
    return {
      ...s,
      incidents,
      generatedAt: new Date().toISOString()
    };
  });

  // ---- monitors ----
  app.get('/api/monitors', async () => store.allStatuses());

  app.get<{ Params: { id: string } }>('/api/monitors/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const monitor = store.get(id);
    if (!monitor) return reply.code(404).send({ error: 'monitor not found' });
    return store.statusFor(monitor);
  });

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/api/monitors/:id/history',
    async (req, reply) => {
      const id = Number(req.params.id);
      const monitor = store.get(id);
      if (!monitor) return reply.code(404).send({ error: 'monitor not found' });

      const days = clampDays(req.query.days);
      const buckets = store.bucketsFor(id, days);
      const recent = store.checksFor(id, 60).reverse();
      return {
        monitor,
        days,
        buckets,
        recent: recent.map((c) => ({
          checkedAt: c.checkedAt,
          ok: c.ok,
          statusCode: c.statusCode,
          latencyMs: c.latencyMs,
          error: c.error
        }))
      };
    }
  );

  app.post('/api/monitors', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = (req.body ?? {}) as Partial<CreateMonitorInput>;

    const errors = validateMonitor(body);
    if (errors.length) return reply.code(422).send({ error: 'validation failed', errors });

    const created = store.create({
      name: body.name!,
      url: body.url!,
      method: body.method,
      expectStatus: body.expectStatus,
      timeoutMs: body.timeoutMs,
      intervalS: body.intervalS
    });
    return reply.code(201).send(store.statusFor(created));
  });

  app.patch<{ Params: { id: string } }>('/api/monitors/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.params.id);
    if (!store.get(id)) return reply.code(404).send({ error: 'monitor not found' });

    const body = (req.body ?? {}) as Partial<CreateMonitorInput> & { active?: boolean };
    const errors = validateMonitor({
      // only validate fields that are present
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.url !== undefined ? { url: body.url } : {}),
      ...(body.expectStatus !== undefined ? { expectStatus: body.expectStatus } : {}),
      ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
      ...(body.intervalS !== undefined ? { intervalS: body.intervalS } : {})
    }).filter((e) => e.field !== 'name' || body.name !== undefined)
      .filter((e) => e.field !== 'url' || body.url !== undefined);

    if (errors.length) return reply.code(422).send({ error: 'validation failed', errors });

    const updated = store.update(id, body);
    return store.statusFor(updated!);
  });

  app.delete<{ Params: { id: string } }>('/api/monitors/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const ok = store.remove(Number(req.params.id));
    if (!ok) return reply.code(404).send({ error: 'monitor not found' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/monitors/:id/check', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const monitor = store.get(Number(req.params.id));
    if (!monitor) return reply.code(404).send({ error: 'monitor not found' });

    const check = await runMonitorCheck(store, monitor);
    return { check, status: store.statusFor(monitor) };
  });

  // ---- preview a URL before adding it ----
  app.post('/api/preview', async (req, reply) => {
    const body = (req.body ?? {}) as { url?: string };
    if (!body.url || !parseTargetUrl(body.url)) {
      return reply.code(422).send({ error: 'url must be an absolute http(s) URL' });
    }
    const started = Date.now();
    try {
      const res = await fetch(body.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000) });
      return { reachable: true, status: res.status, latencyMs: Date.now() - started };
    } catch (err) {
      return { reachable: false, status: null, latencyMs: Date.now() - started, error: String(err) };
    }
  });
}

function clampDays(raw: string | undefined): number {
  const n = Number(raw ?? 90);
  if (!Number.isFinite(n)) return 90;
  return Math.min(365, Math.max(1, Math.round(n)));
}
