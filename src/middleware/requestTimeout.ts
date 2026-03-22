import { Request, Response, NextFunction } from 'express';
import { getRequestDbProcessIds } from './requestContext';

export function requestTimeout(
  _req: Request,
  _res: Response,
  next: NextFunction
) {
  // placeholder (safe)
  getRequestDbProcessIds();
  next();
}
