import { Request, Response, NextFunction } from 'express';
import { fetchRequestDbProcessIds } from './requestContext';

export function requestTimeout(
  _req: Request,
  _res: Response,
  next: NextFunction
) {
  // placeholder (safe)
  fetchRequestDbProcessIds();
  next();
}
