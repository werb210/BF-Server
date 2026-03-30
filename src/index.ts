console.log('BOOT: start');

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
  process.exit(1);
});

import { createServer } from './server/createServer';
import { assertEnv } from './env';
import { assertSingleServerStart } from './server/runtimeGuards';

async function initServices() {
  const { getPrisma } = await import('./lib/db.js');
  const { getRedisOrNull } = await import('./lib/redis.js');

  // Initialize Prisma client lazily; do not block on DB handshakes here.
  void getPrisma();

  const redis = getRedisOrNull();
  const redisWithConnect = redis as (typeof redis & { connect?: () => Promise<void> }) | null;
  if (redisWithConnect?.connect) {
    await redisWithConnect.connect();
  }
}

function boot() {
  try {
    console.log('BOOT: env check');
    assertEnv();

    console.log('BOOT: guard check');
    assertSingleServerStart();

    console.log('BOOT: creating server');
    const app = createServer();

    const port = Number(process.env.PORT) || 8080;

    console.log('BOOT: starting listen');

    const startTimeout = setTimeout(() => {
      console.error('BOOT TIMEOUT: server failed to start in 30s');
      process.exit(1);
    }, 30000);

    const server = app.listen(port, '0.0.0.0', async () => {
      console.log(`BOOT: listening on ${port}`);
      clearTimeout(startTimeout);

      try {
        await initServices();
        console.log('BOOT: services ready');
      } catch (err) {
        console.error('BOOT: init failed', err);
      }
    });

    server.setTimeout(30000);
  } catch (err) {
    console.error('BOOT FAILED:', err);
    process.exit(1);
  }
}

boot();
