// BF_SERVER_v784_MAYA_IDENTITY
// Who the Maya agent is talking to comes ONLY from the verified Authorization
// token. Before this, the proxy forwarded the caller's own X-Maya-Audience
// header and body.phone / body.staff, so anyone could tell Maya "I am staff" or
// "I am the client with phone X" and read that person's data.
//
//   no token / invalid token -> "public"
//   client OTP token         -> "client" + phone from the token
//   staff human token        -> "staff" + {id,name,email,role} from the users row
//   service token            -> "public". Service tokens (the agent itself,
//     legacy {id:"agent-service", role:"Staff"}) carry no human identity and the
//     old proxy never resolved one for them (no sub -> no staff lookup), so they
//     keep the anonymous audience here.
//   anything else (lender, referrer, accountant, applicant, tracked link) -> "public"
//
// The agent receives the identity as a short-lived HS256 JWT in X-Maya-Context
// (plus X-Maya-Audience mirroring the derived audience for older agent builds).
import { signServiceToken } from "../auth/serviceTokens.js"; // BF_SERVER_v789_SERVICE_TOKENS
import { pool } from "../db.js";
import { principalFromRequest, type Principal } from "../auth/principal.js";
import { logError } from "../observability/logger.js";

export type MayaAudience = "public" | "client" | "staff";

export type MayaStaff = { id: string; name: string | null; email: string | null; role: string | null };

export type MayaIdentity = {
  audience: MayaAudience;
  phone?: string;
  staff?: MayaStaff;
  silo?: string;
};

const VALID_SILOS = new Set(["BF", "BI", "SLF"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function requestedSilo(req: { headers?: Record<string, unknown> }): string | null {
  const raw = req.headers?.["x-silo"];
  const v = (Array.isArray(raw) ? str(raw[0]) : str(raw)).trim().toUpperCase();
  return VALID_SILOS.has(v) ? v : null;
}

/** Staff user id from a verified staff token (id/sub/userId all name users.id). */
export function staffIdFromPrincipal(p: Principal | null): string | null {
  if (!p || p.kind !== "staff") return null;
  return str(p.claims.id) || str(p.claims.sub) || str(p.claims.userId) || null;
}

/** Loads the staff identity for a users.id. Returns null when no such user. */
export async function loadStaffIdentity(
  userId: string,
  fallbackRole: string | null,
  requested: string | null,
): Promise<{ staff: MayaStaff; silo: string } | null> {
  try {
    const r = await pool.query<{
      first_name: string | null; last_name: string | null; email: string | null;
      role: string | null; silo: string | null; silos: string[] | null;
    }>(
      "SELECT first_name, last_name, email, role, silo, silos FROM users WHERE id::text = $1 LIMIT 1",
      [userId],
    );
    const row = r.rows?.[0];
    if (!row) return null;
    const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || null;
    const role = row.role ?? fallbackRole;
    const primary = VALID_SILOS.has(String(row.silo ?? "").toUpperCase()) ? String(row.silo).toUpperCase() : "BF";
    const allow = Array.isArray(row.silos) ? row.silos.map((s) => String(s).toUpperCase()) : [];
    // Same rule as siloMiddleware: Admin any silo, others only their allowlist.
    const silo = requested && (String(role ?? "").toLowerCase() === "admin" || allow.includes(requested)) ? requested : primary;
    return { staff: { id: userId, name, email: row.email ?? null, role }, silo };
  } catch (e: any) {
    logError("maya_staff_identity_lookup_failed", { code: "maya_staff_identity_lookup_failed", error: e?.message ?? "unknown" });
    // The token is verified staff; keep the audience with what the token says.
    return { staff: { id: userId, name: null, email: null, role: fallbackRole }, silo: requested ?? "BF" };
  }
}

/** Derives the Maya identity from the verified bearer token only. */
export async function deriveMayaIdentity(req: { headers?: Record<string, unknown> }): Promise<MayaIdentity> {
  const requested = requestedSilo(req);
  const p = principalFromRequest(req);
  if (p?.kind === "client" && p.phone) {
    return { audience: "client", phone: p.phone, silo: requested ?? "BF" };
  }
  if (p?.kind === "staff") {
    const id = staffIdFromPrincipal(p);
    if (id) {
      const loaded = await loadStaffIdentity(id, str(p.claims.role) || null, requested);
      if (loaded) return { audience: "staff", staff: loaded.staff, silo: loaded.silo };
    }
  }
  return { audience: "public", silo: requested ?? "BF" };
}

export function signMayaContext(identity: MayaIdentity): string {
  // BF_SERVER_v789_SERVICE_TOKENS - iss "bf-server", aud "agent"; kind stays "maya_context".
  const payload: Record<string, unknown> = { audience: identity.audience };
  if (identity.phone) payload.phone = identity.phone;
  if (identity.staff) payload.staff = identity.staff;
  if (identity.silo) payload.silo = identity.silo;
  return signServiceToken("agent", { kind: "maya_context", claims: payload });
}

export function mayaContextHeaders(identity: MayaIdentity): Record<string, string> {
  return { "X-Maya-Context": signMayaContext(identity), "X-Maya-Audience": identity.audience };
}
