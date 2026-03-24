import { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { logger } from "../platform/logger";
import { sendSlackAlert } from "../observability/alerts";
import { captureException } from "../observability/sentry";

type ErrorWithStatus = Error & { status?: number };

type RequestWithUser = Request & {
  user?: {
    userId?: string;
  };
};

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation failed",
      details: err.issues,
    });
    return;
  }

  const typedError = err as ErrorWithStatus;
  const message = typedError?.message || "Internal Server Error";
  const status = typedError?.status ?? 500;
  const userId = (req as RequestWithUser).user?.userId;

  logger.error("request_failed", {
    event: "request_failed",
    status,
    error: message,
    path: req.path,
    userId,
  });

  if (status >= 500) {
    captureException(err);
    void sendSlackAlert(`Critical API error on ${req.path} (status ${status})`);
  }

  res.status(status).json({
    error: message,
  });
}
