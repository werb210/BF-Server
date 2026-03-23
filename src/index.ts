import { startServer } from './server/index';
import { logger } from './platform/logger';

async function bootstrap() {
  try {
    await startServer();
  } catch (err) {
    logger.error('fatal_startup_error', { err: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

void bootstrap();
