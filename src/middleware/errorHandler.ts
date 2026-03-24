import { type NextFunction, type Request, type Response } from "express";

type ErrorWithStatus = Error & { status?: number; code?: string };

export function errorHandler(err: ErrorWithStatus, _req: Request, res: Response, _next: NextFunction): void {
  const status = err.status || 500;

  res.status(status).json({
    error: {
      message: err.message || "internal_error",
      code: err.code || "internal_error",
    },
  });
}
