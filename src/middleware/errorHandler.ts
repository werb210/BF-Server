import { Request, Response, NextFunction } from 'express';
import { logger } from '../server/utils/logger';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  logger.error('Unhandled error', err as any);

  return res.status(500).json({
    error: 'Internal Server Error'
  });
}
