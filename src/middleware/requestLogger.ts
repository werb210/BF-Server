import { Request, Response, NextFunction } from "express";
import { trackRequest } from "../observability/appInsights";
import { logError, logInfo } from "../observability/logger";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const requestId = res.locals.requestId ?? req.id ?? "unknown";

  logInfo("request_started", {
    requestId,
    method: req.method,
    path: req.path,
  });

  res.on("finish", () => {
    const durationMs = Date.now() - start;
    if (res.statusCode >= 500) {
      logError("request_failed", {
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs,
      });
    }

    logInfo("request_completed", {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs,
    });

    trackRequest({
      name: `${req.method} ${req.path}`,
      url: req.originalUrl || req.url,
      duration: durationMs,
      resultCode: res.statusCode,
      success: res.statusCode < 500,
      properties: {
        requestId,
      },
    });
  });

  next();
}
