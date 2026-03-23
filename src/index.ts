import { startServer } from './server/index';

async function bootstrap() {
  try {
    await startServer();
  } catch (err) {
    console.error('FATAL: Failed to start server', err);
    process.exit(1);
  }
}

bootstrap();
