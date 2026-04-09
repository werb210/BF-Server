import { type NextFunction, type Request, type Response } from "express";
import { logInfo } from "../observability/logger.js";

export function routeResolutionLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  res.on("finish", () => {
    // If no route matched, Express never sets req.route
    if (!req.route) {
      return;
    }

    const requestId = res.locals.requestId ?? "unknown";

    logInfo("route_resolved", {
      requestId,
      method: req.method,
      originalUrl: req.originalUrl,
      baseUrl: req.baseUrl || undefined,
      routePath: req.route.path,
    });
  });

  next();
}
