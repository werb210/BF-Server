import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

export function requestId(req: Request, res: Response, next: NextFunction) {
  const rid = randomUUID();

  (req as any).rid = rid;
  res.setHeader("x-request-id", rid);

  next();
}
