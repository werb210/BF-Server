// BF_SERVER_DOCS_NEEDED_OWNERSHIP_v1
// Single definition of "does this OTP caller own this application", shared by
// every /api/client/* route mounted outside src/routes/client/index.ts and
// therefore outside its guard. Fails closed.
import type { Request } from "express";

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
