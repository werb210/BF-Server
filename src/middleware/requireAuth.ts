import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { error } from "../lib/response.js";
// BF_SERVER_v784_STAFF_ONLY_AUTH
import { classifyClaims, staffRejectionStatus } from "../auth/principal.js";

// BF_SERVER_v784_STAFF_ONLY_AUTH - staff humans and service principals only.
// Client-app routes opt in by name with requireAuthAllowClient.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  return authenticate(req, res, next, false);
}

export function requireAuthAllowClient(req: Request, res: Response, next: NextFunction) {
  return authenticate(req, res, next, true);
}

function authenticate(req: Request, res: Response, next: NextFunction, allowClient: boolean) {
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
    const verified = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    if (!verified || typeof verified !== "object") {
      return res.status(401).json(error("Invalid token", rid));
    }
    const decoded = verified as Record<string, unknown>;
    const principal = classifyClaims(decoded);
    const rejection = allowClient && principal.kind === "client" ? null : staffRejectionStatus(principal);
    if (rejection) {
      return res.status(rejection).json(error(rejection === 401 ? "Invalid token" : "Forbidden", rid));
    }
    const userId =
      typeof decoded.userId === "string"
        ? decoded.userId
        : typeof decoded.sub === "string"
          ? decoded.sub
          : "";
    // A missing role is no longer read as "Staff"; only service tokens get here without one.
    const role = typeof decoded.role === "string" ? decoded.role : undefined;
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
