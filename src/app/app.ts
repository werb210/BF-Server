import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';

import { httpLogger } from '../middleware/logger';
import { rateLimiter } from '../middleware/rateLimit';
import { errorHandler } from '../middleware/error';
import { authRoutes } from '../routes/auth.routes';
import { userRoutes } from '../routes/user.routes';

const app = express();

app.use(helmet());
app.use(compression());

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());
app.use(httpLogger);
app.use(rateLimiter);

app.get('/health', (_, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);

app.use(errorHandler);

export default app;
