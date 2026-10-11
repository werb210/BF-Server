// BF_SERVER_MAYA_CONTEXT_v1
// Who Maya is talking to is decided HERE, from the caller's verified bearer
// token, and handed to the agent as a short-lived signed X-Maya-Context JWT.
// Caller-supplied X-Maya-Audience, body.phone and body.staff are never trusted:
// before this, anyone could POST /api/maya/message with X-Maya-Audience: staff
// (and/or a body.phone) and get staff tools or another client's file.
import jwt from "jsonwebtoken";
import type { Request } from "express";
import { pool } from "../db.js";
import { classifyPrincipal } from "../auth/principal.js";

export type MayaAudience = "public" | "client" | "staff";
export type MayaStaff = { id: string; name: string | null; email: string | null; role: string | null };
export type MayaIdentity = { audience: MayaAudience; phone?: string; staff?: MayaStaff; silo?: string };

const SILOS = new Set(["BF", "BI", "SLF"]);

function siloFrom(req?: Request): string | undefined {
  const raw = String(req?.header?.("x-silo") ?? "").trim().toUpperCase();
  return SILOS.has(raw) ? raw : undefined;
}

/** Derive the Maya identity from the request's Authorization header only. */
export async function resolveMayaIdentity(req?: Request): Promise<MayaIdentity> {
  const silo = siloFrom(req);
  const publicId: MayaIdentity = { audience: "public", ...(silo ? { silo } : {}) };
  const authz = String(req?.header?.("authorization") ?? "");
  const m = /^Bearer\s+(.+)$/i.exec(authz);
  const secret = process.env.JWT_SECRET;
  if (!m || !secret) return publicId;
  let claims: Record<string, unknown>;
  try {
    const decoded = jwt.verify(m[1].trim(), secret, { algorithms: ["HS256"] });
    if (!decoded || typeof decoded !== "object") return publicId;
    claims = decoded as Record<string, unknown>;
  } catch {
    return publicId;
  }
  const subject =
    typeof claims.sub === "string" ? claims.sub : typeof claims.id === "string" ? claims.id : "";
  const kind = classifyPrincipal(claims);
  if (kind === "client") {
    const phone = typeof claims.phone === "string" && claims.phone.trim() ? claims.phone.trim() : undefined;
    return { audience: "client", ...(phone ? { phone } : {}), ...(silo ? { silo } : {}) };
  }
  if (kind === "staff" && subject) {
    let staff: MayaStaff = { id: subject, name: null, email: null, role: typeof claims.role === "string" ? claims.role : null };
    try {
      const u = await pool.query<{ first_name: string | null; last_name: string | null; email: string | null; role: string | null }>(
        "SELECT first_name, last_name, email, role FROM users WHERE id::text = $1 LIMIT 1",
        [subject],
      );
      const row = u.rows?.[0];
      if (row) {
        const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || null;
        staff = { id: subject, name, email: row.email ?? null, role: row.role ?? staff.role };
        // A users row whose role is not a staff role (e.g. Referrer) is not staff.
        if (classifyPrincipal(claims, row.role) !== "staff") return publicId;
      }
    } catch (err) {
      console.warn("[maya-context] staff lookup failed", { message: err instanceof Error ? err.message : String(err) });
    }
    return { audience: "staff", staff, ...(silo ? { silo } : {}) };
  }
  // Service, lender, referrer, accountant, applicant and unknown tokens get no identity.
  return publicId;
}

/** Sign the X-Maya-Context header value (HS256, 5 minutes). */
export function signMayaContext(identity: MayaIdentity): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not configured");
  return jwt.sign({ kind: "maya_context", ...identity }, secret, { algorithm: "HS256", expiresIn: "5m" });
}
