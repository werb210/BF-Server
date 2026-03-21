import { NextFunction, Request, Response } from "express";
import { trackException } from "../observability/appInsights";

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  const status = typeof err?.status === "number" ? err.status : 500;
  const code = typeof err?.code === "string" ? err.code : "internal_error";
  const message = typeof err?.message === "string" ? err.message : "Internal Server Error";
  const requestId = res.locals.requestId ?? req.id ?? "unknown";

  trackException({
    exception: err instanceof Error ? err : new Error(message),
    properties: {
      requestId,
      path: req.originalUrl,
      method: req.method,
      code,
      status,
    },
  });

  if (process.env.TEST_LOGGING === "true") {
    console.error(`[error] requestId=${requestId} code=${code} status=${status} stack=${err?.stack ?? message}`);
  }

  res.status(status).json({
    success: false,
    code,
    message,
    requestId,
  });
}
