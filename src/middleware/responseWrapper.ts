import { Request, Response, NextFunction } from "express";

export function safeResponseWrapper(_req: Request, res: Response, next: NextFunction) {
  // DO NOT override res.json globally
  next();
}
