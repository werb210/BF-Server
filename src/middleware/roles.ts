import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';

export function requireRole(role: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const userRole = (req.user as any)?.role;

    if (userRole !== role) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    next();
  };
}
