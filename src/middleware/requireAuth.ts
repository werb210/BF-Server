import type { NextFunction, Request, Response } from "express";
import { getEnv } from "../config/env";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const { JWT_SECRET } = getEnv();

  if (!JWT_SECRET) {
    return res.status(500).json({
      status: "error",
      error: "Auth not configured",
    });
  }

  const auth = req.headers.authorization;

  if (!auth) {
    return res.status(401).json({
      status: "error",
      error: "Unauthorized",
    });
  }

  return next();
}

export default requireAuth;
