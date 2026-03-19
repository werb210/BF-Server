import { randomUUID } from "crypto";
import { type NextFunction, type Request, type Response } from "express";

export function requestId(req: Request, res: Response, next: NextFunction): void {
  req.id = String(req.headers["x-request-id"] || randomUUID());
  res.setHeader("X-Request-Id", req.id);

  next();
}
