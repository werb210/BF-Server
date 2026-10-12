// BF_SERVER_v784_STAFF_ONLY_AUTH
// One place that says what kind of principal a verified JWT_SECRET token is.
// Every token family in this repo is signed with the same secret (staff, client
// OTP, accountant, lender/referrer portals, BI applicant, SMS tracked links,
// service tokens), so "the signature verified" says nothing about who is
// calling. The staff middlewares use this to admit only staff humans and
// service principals.
import jwt from "jsonwebtoken";
import { isStaffRole } from "./roles.js";
import { looksLikeServiceToken, tryVerifyServiceToken } from "./serviceTokens.js"; // BF_SERVER_v789_SERVICE_TOKENS

export type PrincipalKind =
  | "staff"
  | "service"
  | "client"
  | "lender"
  | "referrer"
  | "accountant"
  | "applicant"
  | "tracked_link"
  | "no_role"
  | "unknown_role";

export type Principal = {
  kind: PrincipalKind;
  claims: Record<string, unknown>;
  serviceName?: string;
  phone?: string;
};

// Legacy agent/Maya tokens: {id:"agent-service", role:"Staff"} with no kind claim.
const LEGACY_SERVICE_IDS = new Set(["agent-service", "maya-service"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function classifyClaims(claims: Record<string, unknown>): Principal {
  const role = str(claims.role);
  const roleLower = role.toLowerCase();
  const sub = str(claims.sub);
  const id = str(claims.id) || str(claims.userId) || sub;

  if (claims.kind === "service" || claims.principal === "service") {
    return { kind: "service", claims, serviceName: str(claims.service) || str(claims.source) || id || "unknown" };
  }
  if (LEGACY_SERVICE_IDS.has(id) && isStaffRole(role)) {
    return { kind: "service", claims, serviceName: id === "agent-service" ? "agent" : "maya" };
  }
  if (claims.kind === "applicant") return { kind: "applicant", claims };
  if (claims.isClient === true || roleLower === "client" || sub.startsWith("client:")) {
    return { kind: "client", claims, phone: str(claims.phone) || sub.replace(/^client:/, "") };
  }
  if (claims.isAccountant === true || roleLower === "accountant" || sub.startsWith("accountant:")) {
    return { kind: "accountant", claims };
  }
  if (roleLower === "lender" || sub.startsWith("lender:")) return { kind: "lender", claims };
  if (roleLower === "referrer" || roleLower === "broker" || sub.startsWith("referrer:")) return { kind: "referrer", claims };
  if (!role) {
    if (claims.sid !== undefined && claims.u !== undefined) return { kind: "tracked_link", claims };
    return { kind: "no_role", claims };
  }
  if (isStaffRole(role)) return { kind: "staff", claims };
  return { kind: "unknown_role", claims };
}

// HS256 only; returns null on a missing secret or any verification failure.
// BF_SERVER_v789_SERVICE_TOKENS - a service token verifies with its sender's key
// (BI_SERVICE_JWT_SECRET / AGENT_SERVICE_JWT_SECRET when set) via verifyServiceToken.
export function verifyPrincipalToken(token: string | null | undefined): Principal | null {
  if (!token) return null;
  if (looksLikeServiceToken(token)) {
    const verified = tryVerifyServiceToken(token);
    return verified ? classifyClaims(verified.claims) : null;
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (!decoded || typeof decoded !== "object") return null;
    return classifyClaims(decoded as Record<string, unknown>);
  } catch {
    return null;
  }
}

export function bearerToken(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}

export function principalFromRequest(req: { headers?: Record<string, unknown> }): Principal | null {
  return verifyPrincipalToken(bearerToken(req.headers?.authorization));
}

export function isStaffOrService(p: Principal | null): boolean {
  return !!p && (p.kind === "staff" || p.kind === "service");
}

// 401 for a token that names nobody (tracked link, no role); 403 for a real
// principal of the wrong kind (client, lender, referrer, accountant, applicant).
export function staffRejectionStatus(p: Principal): 401 | 403 | null {
  if (p.kind === "staff" || p.kind === "service") return null;
  if (p.kind === "tracked_link" || p.kind === "no_role") return 401;
  return 403;
}
