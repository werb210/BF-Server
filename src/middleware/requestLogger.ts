import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger';
import { trackRequest } from '../routes/metrics';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  trackRequest();
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;

    logger.info('request', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration
    });
  });

  next();
}
