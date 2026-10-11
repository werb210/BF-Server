// BF_SERVER_DOCS_NEEDED_OWNERSHIP_v1
// Single definition of "does this OTP caller own this application", shared by
// every /api/client/* route mounted outside src/routes/client/index.ts and
// therefore outside its guard. Fails closed.
import type { NextFunction, Request, Response } from "express";

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

// BF_SERVER_CLIENT_OWNERSHIP_v1
// One ownership rule for every client-facing route that names an application.
// A client token proves a verified phone. The application belongs to that
// phone when any contact linked to it (application_contacts, or the legacy
// applications.contact_id) carries the same last-10 digits.
//
// An application that exists but has NO contact with a usable phone yet (the
// local-first wizard only links contacts at Step 6 submit) is treated as
// claimable by the signed-in client, exactly as BF_SERVER_UNCLAIMED_APP_
// OWNERSHIP_v10 already decided. The moment any contact with a phone is
// linked, only that phone owns it.

export type OwnershipResult = "owner" | "not_owner" | "not_found";

export function phoneLast10(raw: unknown): string {
  return String(typeof raw === "string" ? raw : "").replace(/[^0-9]/g, "").slice(-10);
}

export async function clientOwnershipOf(applicationId: string, phone: unknown): Promise<OwnershipResult> {
  const phone10 = phoneLast10(phone);
  const { pool } = await import("../db.js");
  const r = await pool.query<{ total: number; mine: number; known: number }>(
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
     SELECT
       (SELECT COUNT(*)::int FROM applications WHERE id::text = ($1)::text) AS total,
       (SELECT COUNT(*)::int FROM app_phones WHERE p10 = $2 AND p10 <> '') AS mine,
       (SELECT COUNT(*)::int FROM app_phones WHERE p10 <> '')              AS known`,
    [applicationId, phone10],
  );
  const total = Number(r.rows?.[0]?.total ?? 0);
  const mine = Number(r.rows?.[0]?.mine ?? 0);
  const known = Number(r.rows?.[0]?.known ?? 0);
  if (total === 0) return "not_found";
  if (mine > 0) return "owner";
  if (known === 0 && phone10.length === 10) return "owner";
  return "not_owner";
}

/**
 * Route guard used after an auth middleware that admitted client tokens.
 * Staff and service principals pass; a client must own the application named
 * by `pick(req)`. Anything else is refused.
 */
export function requireClientOwnsApplication(pick: (req: Request) => unknown) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user as Record<string, unknown> | undefined;
    const kind = String(user?.principalKind ?? "");
    if (kind === "staff" || kind === "service") return next();
    if (kind !== "client") return res.status(403).json({ error: "forbidden" });
    const applicationId = String(pick(req) ?? "").trim();
    if (!applicationId) return res.status(400).json({ error: "applicationId_required" });
    try {
      const own = await clientOwnershipOf(applicationId, user?.phone);
      if (own === "owner") return next();
      return res.status(own === "not_found" ? 404 : 403).json({ error: own === "not_found" ? "not_found" : "forbidden" });
    } catch (err) {
      console.error("[client-ownership] check failed", { applicationId, err: String(err) });
      return res.status(500).json({ error: "ownership_check_failed" });
    }
  };
}
