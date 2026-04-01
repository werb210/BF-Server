import type { NextFunction, Request, Response } from "express";

export function routeAlias(req: Request, res: Response, next: NextFunction) {
  if (req.path !== "/api" && !req.path.startsWith("/api/")) {
    return res.status(410).json({
      success: false,
      error: "LEGACY_ROUTE_DISABLED",
    });
  }

  return next();
}

export default routeAlias;
