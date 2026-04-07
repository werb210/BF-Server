import crypto from "crypto";
import { Request, Response, NextFunction } from "express";

export function wrap(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any> | any
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await fn(req, res, next);

      if (!res.headersSent && result !== undefined) {
        res.json(result);
      }
    } catch (err) {
      next(err);
    }
  };
}

export function ok(res: Response, data: any) {
  return res.json({
    status: "ok",
    data,
  });
}

export function error(res: Response, message: string, status = 400) {
  return res.status(status).json({
    status: "error",
    error: message,
    rid: crypto.randomUUID(),
  });
}
