// BF_SERVER_STAFF_ONLY_AUTH_v1
// Every token BF-Server issues is signed with the same JWT_SECRET, so a valid
// signature says nothing about WHO the bearer is. Client OTP tokens, lender /
// referrer / accountant portal tokens and SMS tracked-link tokens all verify.
// This module classifies a verified payload so the auth middlewares can admit
// only staff humans and service principals on staff routes, and admit the
// other kinds only where a route explicitly opts in.
import { ROLES, normalizeRole } from "./roles.js";

export type PrincipalKind =
  | "staff"
  | "service"
  | "client"
  | "accountant"
  | "lender"
  | "referrer"
  | "applicant"
  | "unknown";

/** Non-staff kinds a route may explicitly allow. "unknown" can never be allowed. */
export type NonStaffKind = "client" | "accountant" | "lender" | "referrer" | "applicant";

export const STAFF_ROLES: ReadonlySet<string> = new Set([
  ROLES.ADMIN,
  ROLES.STAFF,
  ROLES.OPS,
  ROLES.MARKETING,
]);

// Legacy service ids (agent before AGENT_UNIFIED_SERVICE_TOKEN_v1, Maya).
const LEGACY_SERVICE_IDS: ReadonlySet<string> = new Set(["agent-service", "maya-service"]);

/**
 * Classify a verified JWT payload.
 * @param claims verified payload
 * @param dbRole role of the matching users row, when one was found (it wins
 *               over the role claim, exactly as the auth middleware already does)
 */
export function classifyPrincipal(
  claims: Record<string, unknown>,
  dbRole?: string | null,
): PrincipalKind {
  const kind = typeof claims.kind === "string" ? claims.kind : "";
  const id =
    typeof claims.id === "string"
      ? claims.id
      : typeof claims.sub === "string"
        ? claims.sub
        : typeof claims.userId === "string"
          ? claims.userId
          : "";
  const tokenRole = typeof claims.role === "string" ? claims.role : "";

  if (kind === "service" || claims.principal === "service") return "service";
  if (id && LEGACY_SERVICE_IDS.has(id) && STAFF_ROLES.has(tokenRole)) return "service";

  if (kind === "applicant") return "applicant";
  // BI-Server lender / referrer tokens carry kind instead of role.
  if (kind === "lender") return "lender";
  if (kind === "referrer") return "referrer";
  if (kind) return "unknown";

  if (claims.isClient === true || tokenRole === "client" || id.startsWith("client:")) return "client";
  if (claims.isAccountant === true || tokenRole === "accountant" || id.startsWith("accountant:")) {
    return "accountant";
  }

  // A role must come from the token or from the users row its subject names
  // (only BF-minted staff tokens carry a users.id subject).
  if (!tokenRole && !dbRole) return "unknown";
  // Case-insensitive: some users rows hold "staff" / "admin" (login normalizes them too).
  const role = normalizeRole(dbRole ?? tokenRole) ?? "";
  if (role === ROLES.LENDER) return "lender";
  if (role === ROLES.REFERRER) return "referrer";
  // A staff role needs a subject: tracked-link ({sid,u}) and other
  // capability payloads carry neither and must never authenticate.
  if (id && STAFF_ROLES.has(role)) return "staff";
  return "unknown";
}

export function isStaffOrService(kind: PrincipalKind): boolean {
  return kind === "staff" || kind === "service";
}
