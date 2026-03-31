import { NextFunction, Request, Response } from "express";
import { trackRequest } from "../routes/metrics";

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  trackRequest();

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  req.requestId = id;
  req.id = id;

  res.setHeader("X-Request-Id", id);

  console.log({
    id,
    method: req.method,
    path: req.path,
    time: new Date().toISOString(),
  });

  next();
}
