import { Request, Response, NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;

  if (!auth) {
    return res.status(401).json({
      ok: false,
      error: "Missing Authorization header"
    });
  }

  // DEV MODE BYPASS
  if (process.env.NODE_ENV !== "production") {
    return next();
  }

  // PRODUCTION (future)
  const token = auth.replace("Bearer ", "");

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({
      ok: false,
      error: "JWT secret not configured"
    });
  }

  // TODO: real verification later

  next();
}
