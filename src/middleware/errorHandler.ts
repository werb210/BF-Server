import { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";

type ErrorWithStatus = Error & { status?: number };

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  console.error(err);

  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation failed",
      details: err.issues,
      requestId: req.requestId,
    });
    return;
  }

  const typedError = err as ErrorWithStatus;

  res.status(typedError.status || 500).json({
    error: typedError.message || "internal_error",
    requestId: req.requestId,
  });
}
