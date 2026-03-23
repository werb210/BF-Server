import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import healthRouter from './routes/health';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './lib/logger';
import { ENV } from './config/env';
import { globalRateLimit } from './middleware/rateLimit';
import { requestLogger } from './middleware/requestLogger';

const app = express();

app.use(helmet());
app.use(globalRateLimit);
app.use(requestLogger);
app.use(cors());
app.use(express.json());

app.use('/', healthRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use(errorHandler);

const PORT = Number(ENV.PORT);

const server = app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

function shutdown() {
  logger.info('Shutting down server...');
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
