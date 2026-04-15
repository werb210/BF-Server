import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { error } from "../lib/response.js";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  const rid = req.id ?? req.rid;

  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json(error("Unauthorized", rid));
  }

  const token = auth.split(" ")[1];

  if (!token) {
    return res.status(401).json(error("Unauthorized", rid));
  }
  const JWT_SECRET = process.env.JWT_SECRET;

  if (!JWT_SECRET) {
    return res.status(500).json(error("Auth not configured", rid));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
    const userId =
      typeof decoded.userId === "string"
        ? decoded.userId
        : typeof decoded.sub === "string"
          ? decoded.sub
          : "";
    const role = typeof decoded.role === "string" ? decoded.role : "Staff";
    const siloClaim = typeof decoded.silo === "string" ? decoded.silo.trim() : "";

    req.user = {
      ...decoded,
      id: userId,
      userId,
      role,
      phone: typeof decoded.phone === "string" ? decoded.phone : null,
      silo: siloClaim || "staff",
      siloFromToken: Boolean(siloClaim),
      capabilities: Array.isArray(decoded.capabilities) ? decoded.capabilities : [],
    } as Request["user"];
    return next();
  } catch {
    return res.status(401).json(error("Invalid token", rid));
  }
}

export default requireAuth;
