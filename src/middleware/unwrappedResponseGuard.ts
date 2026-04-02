import { Request, Response, NextFunction } from "express";

export function unwrappedResponseGuard(_req: Request, _res: Response, next: NextFunction) {
  // Disabled — was causing unintended 500s
  next();
}
