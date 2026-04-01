import type { NextFunction, Request, Response } from "express";

const CANONICAL_NON_API_ROUTES = new Set([
  "/health",
  "/dialer/token",
  "/call/start",
  "/voice/status",
]);

export function routeAlias(req: Request, res: Response, next: NextFunction) {
  if (req.path !== "/api" && !req.path.startsWith("/api/") && !CANONICAL_NON_API_ROUTES.has(req.path)) {
    return res.status(410).json({
      success: false,
      error: "LEGACY_ROUTE_DISABLED",
    });
  }

  return next();
}

export default routeAlias;
