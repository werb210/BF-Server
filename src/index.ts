import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './lib/logger';
import { ENV } from './config/env';

const app = express();

app.use(cors());
app.use(express.json());

app.use('/', healthRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use(errorHandler);

const PORT = Number(ENV.PORT);

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
