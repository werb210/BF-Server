import type { NextFunction, Request, Response } from "express";
import { isReady } from "../startupState";

export const dbGuard = (req: Request, res: Response, next: NextFunction) => {
  const bypassPrefixes = [
    "/health",
    "/_int",
    "/ready",
  ];
  if (bypassPrefixes.some((prefix) => req.path.startsWith(prefix))) {
    return next();
  }

  if (!isReady()) {
    return res.status(503).json({
      code: "DB_NOT_READY",
      message: "Database unavailable",
    });
  }
  next();
};
