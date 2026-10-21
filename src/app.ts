import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DB } from './db/index.js';
import { MonitorStore } from './core/monitor.js';
import { createWebhookNotifier, noopNotifier, type Notifier } from './core/notifier.js';
import { registerApi } from './routes/api.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/ and src/ sit one level below the project root, so public/ resolves the same either way
const publicRoot = join(here, '..', 'public');

export interface BuildAppOptions {
  db: DB;
  adminToken?: string;
  logger?: boolean;
  /** receive incident open/resolve events */
  notify?: Notifier;
  /** when set, a notifier posting to this URL is created for you */
  webhookUrl?: string;
  webhookFetch?: typeof fetch;
}

export interface BuiltApp {
  app: FastifyInstance;
  store: MonitorStore;
}

export async function buildApp(opts: BuildAppOptions): Promise<BuiltApp> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024 });

  const notify =
    opts.notify ??
    (opts.webhookUrl
      ? createWebhookNotifier({
          url: opts.webhookUrl,
          fetchImpl: opts.webhookFetch,
          log: (msg, meta) => app.log.warn({ msg, meta }, 'webhook')
        })
      : noopNotifier);

  const store = new MonitorStore(opts.db, { notify });

  await app.register(fastifyStatic, { root: publicRoot, index: ['index.html'] });

  registerApi(app, { store, adminToken: opts.adminToken ?? process.env.ADMIN_TOKEN });

  // public status page
  app.get('/status', async (_req, reply) => {
    return reply.sendFile('status.html');
  });

  // Fastify 5 types the handler's error as unknown, so narrow before reading it
  app.setErrorHandler((err: unknown, _req, reply) => {
    const shaped = err as { statusCode?: number; message?: string };
    const status =
      typeof shaped.statusCode === 'number' && shaped.statusCode >= 400 && shaped.statusCode < 600
        ? shaped.statusCode
        : 500;

    // never leak internals on a 500
    const message = status === 500 ? 'internal error' : (shaped.message ?? 'request failed');
    reply.code(status).send({ error: message });
  });

  return { app, store };
}
