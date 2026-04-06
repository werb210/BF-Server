import { Router } from 'express';

export const metricsRoutes = Router();

metricsRoutes.get('/', (_, res) => {
  res.json({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});
