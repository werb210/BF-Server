import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header) {
    res.status(401).json({ ok: false, error: "Missing token" });
    return;
  }

  const token = header.replace("Bearer ", "");
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    res.status(500).json({ ok: false, error: "JWT secret not configured" });
    return;
  }

  try {
    const decoded = jwt.verify(token, secret);
    req.user = decoded as Request["user"];
    next();
  } catch {
    res.status(401).json({ ok: false, error: "Invalid token" });
  }
}
