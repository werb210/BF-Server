import { Request, Response, NextFunction } from 'express';

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // placeholder auth — replace later
  if (!req.headers.authorization) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}
