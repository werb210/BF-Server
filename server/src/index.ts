import express from 'express';
import healthRouter from './routes/health';
import { logger } from './lib/logger';
import { config } from '../../src/config';
import { testDb, waitForDb } from './db/client';

const app = express();

app.use(express.json());

app.use('/', healthRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

const PORT = config.port || 3000;

function startServer() {
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    console.log('ENV DATABASE_URL:', process.env.DATABASE_URL?.replace(/:.+@/, ':****@'));

    testDb().catch(err => {
      console.error('DB INIT FAILED:', err);
    });

    void waitForDb();
  });
}

startServer();
