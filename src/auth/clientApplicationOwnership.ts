// BF_SERVER_DOCS_NEEDED_OWNERSHIP_v1
// Single definition of "does this OTP caller own this application", shared by
// every /api/client/* route mounted outside src/routes/client/index.ts and
// therefore outside its guard. Fails closed.
import type { NextFunction, Request, Response } from "express";
import { isStaffOrService, principalFromRequest, type Principal } from "./principal.js";

// Mirrors the ownership predicate in src/routes/client/index.ts: membership is
// application_contacts (applicant + partner + guarantor) UNION the legacy
// applications.contact_id, so a partner on a joint file is not locked out.
// Unlike that guard, this one FAILS CLOSED - a voice identity is an assertion
// of who you are to a human being, not a read of your own file.
export async function callerOwnsApplication(req: Request, applicationId: string): Promise<boolean> {
  const auth = req.headers?.authorization;
  if (!auth || typeof auth !== "string" || !auth.startsWith("Bearer ")) return false;
  const secret = process.env.JWT_SECRET;
  if (!secret) return false;

  let phone10 = "";
  try {
    const jwt = (await import("jsonwebtoken")).default;
    const decoded = jwt.verify(auth.slice(7), secret) as Record<string, unknown>;
    phone10 = String(typeof decoded.phone === "string" ? decoded.phone : "")
      .replace(/[^0-9]/g, "")
      .slice(-10);
  } catch {
    return false;
  }
  if (!phone10) return false;

  try {
    const { pool } = await import("../db.js");
    const r = await pool.query<{ n: string }>(
      `WITH app_phones AS (
         SELECT right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10) AS p10
           FROM application_contacts ac
           JOIN contacts c ON c.id = ac.contact_id
          WHERE ac.application_id::text = ($1)::text
         UNION
         SELECT right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10) AS p10
           FROM applications a
           JOIN contacts c ON c.id = a.contact_id
          WHERE a.id::text = ($1)::text
       )
       SELECT COUNT(*)::text AS n FROM app_phones WHERE p10 = $2`,
      [applicationId, phone10],
    );
    return Number(r.rows[0]?.n ?? 0) > 0;
  } catch (err: any) {
    console.error("client_voice_ownership_check_failed", { message: err?.message || String(err) });
    return false;
  }
}

// ---------------------------------------------------------------------------
// BF_SERVER_v784_CLIENT_OWNERSHIP
// The client router's guard and the staff-middleware routes that also admit a
// client token (document upload, offer request-changes / term-sheet, lender
// Q&A answers) share one rule:
//   - no token / invalid token                -> 401
//   - staff human or service principal        -> allowed
//   - client token                            -> must own the application, or the
//     application has no phone-bearing contact linked yet (mid-wizard: contacts
//     are only created by the Step 6 submit, see BF_SERVER_UNCLAIMED_APP_OWNERSHIP_v10)
//   - any other principal (lender, referrer, accountant, applicant) -> 403
// An id that is not an existing application is not this guard's business.

export type OwnershipCounts = { total: number; mine: number; known: number };

const OWNERSHIP_SQL = `WITH app_phones AS (
         SELECT right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10) AS p10
           FROM application_contacts ac
           JOIN contacts c ON c.id = ac.contact_id
          WHERE ac.application_id::text = ($1)::text
         UNION
         SELECT right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10) AS p10
           FROM applications a
           JOIN contacts c ON c.id = a.contact_id
          WHERE a.id::text = ($1)::text
       )
       SELECT
         (SELECT COUNT(*)::int FROM applications WHERE id::text = ($1)::text) AS total,
         (SELECT COUNT(*)::int FROM app_phones WHERE p10 = $2)               AS mine,
         (SELECT COUNT(*)::int FROM app_phones WHERE p10 <> '')              AS known`;

export async function applicationOwnershipCounts(applicationId: string, phone10: string): Promise<OwnershipCounts> {
  const { pool } = await import("../db.js");
  const r = await pool.query<{ total: number; mine: number; known: number }>(OWNERSHIP_SQL, [applicationId, phone10]);
  const row = r.rows[0];
  return { total: Number(row?.total ?? 0), mine: Number(row?.mine ?? 0), known: Number(row?.known ?? 0) };
}

export type ApplicationAccess =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403 | 404 | 503; error: string };

function phone10Of(p: Principal): string {
  return String(p.phone ?? "").replace(/[^0-9]/g, "").slice(-10);
}

// Pass `principal` when the caller already verified it; null means "no valid token".
export async function checkApplicationAccess(principal: Principal | null, applicationId: string): Promise<ApplicationAccess> {
  if (!principal) return { ok: false, status: 401, error: "unauthorized" };
  if (isStaffOrService(principal)) return { ok: true, principal };
  if (principal.kind === "tracked_link" || principal.kind === "no_role") return { ok: false, status: 401, error: "unauthorized" };
  if (principal.kind !== "client") return { ok: false, status: 403, error: "forbidden" };
  const phone10 = phone10Of(principal);
  if (!phone10) return { ok: false, status: 403, error: "forbidden" };
  let counts: OwnershipCounts;
  try {
    counts = await applicationOwnershipCounts(applicationId, phone10);
  } catch (err: any) {
    console.error("[client-ownership] check failed", { applicationId, message: err?.message || String(err) });
    return { ok: false, status: 503, error: "ownership_check_unavailable" };
  }
  if (counts.total === 0) return { ok: false, status: 404, error: "not_found" };
  if (counts.mine > 0 || counts.known === 0) return { ok: true, principal };
  return { ok: false, status: 403, error: "forbidden" };
}

// Route-level helper: writes the rejection and returns false, or returns true.
export async function requireApplicationAccess(req: any, res: Response, applicationId: string): Promise<boolean> {
  const access = await checkApplicationAccess(principalFromRequest(req), applicationId);
  if (access.ok) return true;
  res.status(access.status).json({ error: access.error });
  return false;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every id a client request could be naming an application by: ?applicationId,
// body.applicationId, and any UUID path segment (/application/:id/status,
// /applications/:id, ...). Path params are not parsed yet at router.use time,
// so the path is read directly.
export function candidateApplicationIds(req: any): string[] {
  const out = new Set<string>();
  for (const v of [req.query?.applicationId, req.body?.applicationId]) {
    if (typeof v === "string" && v.trim()) out.add(v.trim());
  }
  for (const seg of String(req.path ?? "").split("/")) {
    if (UUID_RE.test(seg)) out.add(seg);
  }
  return [...out];
}

// Router-level guard for src/routes/client/index.ts. Ids that are not
// applications (continuation and submit tokens, public upload, readiness
// prefill, document ids) are left alone so the wizard and mini-portal work.
export async function clientApplicationOwnershipGuard(req: any, res: Response, next: NextFunction) {
  const ids = candidateApplicationIds(req);
  if (!ids.length) return next();
  let existing: string[];
  try {
    const { pool } = await import("../db.js");
    const r = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM applications WHERE id::text = ANY($1::text[])`,
      [ids],
    );
    existing = r.rows.map((row) => String(row.id));
  } catch (err: any) {
    console.error("[client-ownership] application lookup failed", { message: err?.message || String(err) });
    res.status(503).json({ error: "ownership_check_unavailable" });
    return;
  }
  if (!existing.length) return next();
  const principal = principalFromRequest(req);
  for (const applicationId of existing) {
    const access = await checkApplicationAccess(principal, applicationId);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }
  }
  return next();
}
