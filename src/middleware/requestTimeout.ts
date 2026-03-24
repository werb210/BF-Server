import { NextFunction, Request, Response } from "express";

const REQUEST_TIMEOUT_MS = 5_000;

export function requestTimeout(req: Request, res: Response, next: NextFunction): void {
  res.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(503).json({ error: "timeout" });
    }
  });

  next();
}
