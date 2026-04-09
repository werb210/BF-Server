import type { NextFunction, Request, Response } from "express";
import { fail } from "../system/response.js";

const CANONICAL_NON_API_ROUTES = new Set([
  "/health",
  "/ready",
]);

export function routeAlias(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api/v1/") && !CANONICAL_NON_API_ROUTES.has(req.path)) {
    res.locals.__wrapped = true;
    return res.status(410).json(fail("LEGACY_ROUTE_DISABLED", (req as Request & { rid?: string }).rid));
  }

  return next();
}

export default routeAlias;
