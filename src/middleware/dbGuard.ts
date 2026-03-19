import type { NextFunction, Request, Response } from "express";

export const dbGuard = (req: Request, res: Response, next: NextFunction) => {
  if (!req.app.locals.dbReady) {
    return res.status(503).json({
      code: 'DB_NOT_READY',
      message: 'Database unavailable',
    });
  }
  next();
};
