import type { NextFunction, Request, Response } from "express";
import { fail } from "../lib/response";

const CANONICAL_NON_API_ROUTES = new Set([
  "/",
  "/health",
  "/ready",
  "/metrics",
]);

export function routeAlias(req: Request, res: Response, next: NextFunction) {
  const path = req.path;

  if (path.startsWith("/api/public")) {
    res.locals.__wrapped = true;
    return res.status(410).json(fail("LEGACY_ROUTE_DISABLED", (req as Request & { rid?: string }).rid));
  }

  if (path.startsWith("/api/") || path.startsWith("/api/v1/") || CANONICAL_NON_API_ROUTES.has(path)) {
    return next();
  }

  res.locals.__wrapped = true;
  return res.status(410).json(fail("LEGACY_ROUTE_DISABLED", (req as Request & { rid?: string }).rid));
}

export default routeAlias;
