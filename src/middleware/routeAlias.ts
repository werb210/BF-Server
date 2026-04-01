import type { NextFunction, Request, Response } from "express";

const explicitAliases: Record<string, string> = {};

export function routeAlias(req: Request, res: Response, next: NextFunction) {
  if (req.path !== "/api" && !req.path.startsWith("/api/")) {
    const mapped = explicitAliases[req.path];
    if (mapped) {
      req.url = req.url.replace(req.path, mapped);
      return next();
    }

    return res.status(410).json({
      success: false,
      error: "LEGACY_ROUTE_DISABLED",
    });
  }

  return next();
}

export default routeAlias;
