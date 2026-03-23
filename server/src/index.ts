import express from 'express';
import healthRouter from './routes/health';
import { logger } from './lib/logger';
import { config } from '../../src/config';

const app = express();

app.use(express.json());

app.use('/', healthRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

const PORT = config.port || 3000;

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
