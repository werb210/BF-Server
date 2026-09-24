// BF_SERVER_BLOCK_v473_SIGNING_OWNER_v1
// GET /api/client/signing-session hands out a live SignNow signing link. The
// rest of the client surface accepts the application id alone (capability
// model), but a signing link lets the holder sign as the applicant, so this
// route requires the client's OTP session AND that the signed-in phone belongs
// to a contact on the application (applicant, partner or guarantor).
// Fails closed: no token, bad token, no phone claim, not linked, or a DB error
// all refuse the request.
import jwt from "jsonwebtoken";

export type OwnerQuery = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export function phone10FromAuthHeader(auth: unknown, secret: string | undefined): string {
  if (!secret || typeof auth !== "string" || !auth.startsWith("Bearer ")) return "";
  try {
    const decoded = jwt.verify(auth.slice(7), secret) as Record<string, unknown>;
    return String(typeof decoded.phone === "string" ? decoded.phone : "").replace(/[^0-9]/g, "").slice(-10);
  } catch {
    return "";
  }
}

export function makeSigningOwnerGuard(query: OwnerQuery) {
  return async (req: any, res: any, next: any) => {
    const applicationId = typeof req.query?.applicationId === "string" ? req.query.applicationId.trim() : "";
    if (!applicationId) return next(); // the route answers 400 itself
    const phone10 = phone10FromAuthHeader(req.headers?.authorization, process.env.JWT_SECRET);
    if (phone10.length !== 10) {
      return res.status(401).json({ error: "sign_in_required" });
    }
    try {
      const r = await query(
        `WITH app_phones AS (
           SELECT right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10) AS p10
             FROM application_contacts ac
             JOIN contacts c ON c.id = ac.contact_id
            WHERE ac.application_id::text = ($1)::text
           UNION
           SELECT right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10) AS p10
             FROM applications a
             JOIN contacts c ON c.id = COALESCE(a.contact_id,
                  (SELECT p.contact_id FROM applications p WHERE p.id::text = a.parent_application_id::text))
            WHERE a.id::text = ($1)::text
         )
         SELECT COUNT(*)::int AS mine FROM app_phones WHERE p10 = $2`,
        [applicationId, phone10],
      );
      if (Number(r.rows?.[0]?.mine ?? 0) < 1) {
        return res.status(403).json({ error: "not_your_application" });
      }
      return next();
    } catch {
      return res.status(503).json({ error: "ownership_check_failed" });
    }
  };
}
