import { openDb } from './db/index.js';
import { buildApp } from './app.js';
import { createScheduler } from './core/scheduler.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? 'pulse.db';
const TICK_MS = Number(process.env.TICK_MS ?? 5000);

async function main() {
  const db = openDb(DB_PATH);
  const webhookUrl = process.env.WEBHOOK_URL;
  const { app, store } = await buildApp({ db, logger: true, webhookUrl });

  if (webhookUrl) app.log.info({ webhookUrl }, 'webhook alerts enabled');

  const scheduler = createScheduler({
    store,
    tickMs: TICK_MS,
    log: (msg, meta) => app.log.warn({ msg, meta }, 'scheduler')
  });
  scheduler.start();

  app.get('/api/scheduler', async () => scheduler.stats());

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    scheduler.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: PORT, host: HOST });
  console.log(`pulse listening on http://localhost:${PORT}  (db: ${DB_PATH})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
