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

async function boot() {
  try {
    console.log('BOOT: env check');
    assertEnv();

    console.log('BOOT: guard check');
    assertSingleServerStart();

    console.log('BOOT: creating server');
    const app = createServer();

    const port = process.env.PORT || 8080;

    console.log('BOOT: starting listen');

    const startTimeout = setTimeout(() => {
      console.error('BOOT TIMEOUT: server failed to start in 30s');
      process.exit(1);
    }, 30000);

    const server = app.listen(port, () => {
      console.log(`BOOT: listening on ${port}`);
      clearTimeout(startTimeout);
    });

    server.setTimeout(30000);

  } catch (err) {
    console.error('BOOT FAILED:', err);
    process.exit(1);
  }
}

boot();
