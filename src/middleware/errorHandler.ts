import { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status?: number }).status) || 500
      : 500;
  const message =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message?: string }).message)
      : "Internal server error";
  const requestId = req.id ?? res.locals.requestId ?? "unknown";

  logger.error({
    requestId,
    route: req.originalUrl,
    method: req.method,
    status,
    error: message,
  });

  res.status(status).json({
    success: false,
    error: message,
    status,
    requestId,
  });
}
