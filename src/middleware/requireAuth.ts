import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { error } from "../lib/response.js";
// BF_SERVER_STAFF_ONLY_AUTH_v1
import { classifyPrincipal, isStaffOrService, type NonStaffKind } from "../auth/principal.js";

const NO_NON_STAFF: ReadonlySet<NonStaffKind> = new Set();

/** Staff humans and service principals only. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  return requireAuthWith(req, res, next, NO_NON_STAFF);
}

/**
 * BF_SERVER_STAFF_ONLY_AUTH_v1 - explicit allowance for a route that serves a
 * non-staff token (client, lender, referrer, accountant, applicant).
 */
export function requireAuthAllowing(...kinds: NonStaffKind[]) {
  const allowed: ReadonlySet<NonStaffKind> = new Set(kinds);
  return (req: Request, res: Response, next: NextFunction) => requireAuthWith(req, res, next, allowed);
}

function requireAuthWith(
  req: Request,
  res: Response,
  next: NextFunction,
  allowed: ReadonlySet<NonStaffKind>,
) {
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
    // BF_SERVER_JWT_HARDENING_v1 - pin the algorithm.
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as Record<string, unknown>;
    // BF_SERVER_STAFF_ONLY_AUTH_v1 - no more "missing role means Staff".
    const principalKind = classifyPrincipal(decoded);
    if (principalKind === "unknown" && !(typeof decoded.role === "string" && decoded.role && (decoded.sub || decoded.id || decoded.userId))) {
      // Tracked-link ({sid,u}), role-less and other capability payloads.
      return res.status(401).json(error("Invalid token", rid));
    }
    if (!isStaffOrService(principalKind) && !allowed.has(principalKind as NonStaffKind)) {
      console.warn("[requireAuth] non-staff token refused on staff route", {
        kind: principalKind,
        method: req.method,
        path: req.originalUrl?.split("?")[0],
      });
      return res.status(403).json(error("Staff access required", rid));
    }
    const userId =
      typeof decoded.userId === "string"
        ? decoded.userId
        : typeof decoded.sub === "string"
          ? decoded.sub
          : "";
    const role = typeof decoded.role === "string" ? decoded.role : principalKind === "service" ? "Staff" : "";
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
      principalKind,
    } as Request["user"];
    return next();
  } catch {
    return res.status(401).json(error("Invalid token", rid));
  }
}

export default requireAuth;
