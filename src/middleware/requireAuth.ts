import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { error } from "../lib/response.js";
// BF_SERVER_v784_STAFF_ONLY_AUTH
import { classifyClaims, staffRejectionStatus } from "../auth/principal.js";
// BF_SERVER_v789_STAFF_USER_STATE
import { checkStaffUser } from "../auth/staffUserState.js";
import { looksLikeServiceToken, verifyServiceToken } from "../auth/serviceTokens.js";

// BF_SERVER_v784_STAFF_ONLY_AUTH - staff humans and service principals only.
// Client-app routes opt in by name with requireAuthAllowClient.
// BF_SERVER_v789_SAFE_HANDLERS - a rejection goes to next(err), never unhandled.
export function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  return authenticate(req, res, next, false).then(() => undefined, next);
}

export function requireAuthAllowClient(req: Request, res: Response, next: NextFunction): Promise<void> {
  return authenticate(req, res, next, true).then(() => undefined, next);
}

async function authenticate(req: Request, res: Response, next: NextFunction, allowClient: boolean) {
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

  let decoded: Record<string, unknown>;
  try {
    // BF_SERVER_v789_SERVICE_TOKENS - a service token verifies with its sender's key
    // (BI_SERVICE_JWT_SECRET / AGENT_SERVICE_JWT_SECRET when set); everything else
    // with JWT_SECRET.
    const verified = looksLikeServiceToken(token)
      ? verifyServiceToken(token).claims
      : jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    if (!verified || typeof verified !== "object") {
      return res.status(401).json(error("Invalid token", rid));
    }
    decoded = verified as Record<string, unknown>;
  } catch {
    return res.status(401).json(error("Invalid token", rid));
  }
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
  let role = typeof decoded.role === "string" ? decoded.role : undefined;
  let capabilities: unknown[] = Array.isArray(decoded.capabilities) ? decoded.capabilities : [];
  // BF_SERVER_v789_STAFF_USER_STATE - staff humans: the account must be active,
  // unlocked and at the token's tv; the role comes from the database and token
  // capabilities the role does not grant are dropped. Services skip this.
  if (principal.kind === "staff") {
    const userKey = userId || (typeof decoded.id === "string" ? decoded.id : "");
    const check = await checkStaffUser(userKey, decoded, { profile: false });
    if (!check.ok) {
      const message = check.status === 503 ? "Auth unavailable" : check.status === 403 ? "Forbidden" : "Invalid token";
      return res.status(check.status).json(error(message, rid));
    }
    role = check.role;
    capabilities = check.capabilities;
  }
  const siloClaim = typeof decoded.silo === "string" ? decoded.silo.trim() : "";

  req.user = {
    ...decoded,
    id: userId,
    userId,
    role,
    phone: typeof decoded.phone === "string" ? decoded.phone : null,
    silo: siloClaim || "staff",
    siloFromToken: Boolean(siloClaim),
    capabilities,
  } as Request["user"];
  return next();
}

export default requireAuth;
