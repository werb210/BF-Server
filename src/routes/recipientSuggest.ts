// BF_SERVER_RECIPIENT_SUGGEST_v100
// One ranked recipient lookup for every composer, matching what Apple Mail does:
// type three letters, get "Name — email", the person you actually email most at
// the top.
//
// The portal previously had to call two endpoints and merge them client-side,
// with no ranking - teammates alphabetically, then contacts alphabetically. That
// put "Andrea Butters" above "Andrew Polturak" for "andr" even though one gets
// emailed daily and the other never.
//
// Ranking, highest first:
//   1. exact email match          - they typed the address
//   2. name starts with the term  - "andr" -> "Andrew", not "Alexandra"
//   3. correspondence volume      - how many messages you have exchanged
//   4. recency                    - last contacted
// Staff get a floor on their score: a colleague is nearly always who you meant,
// and a new hire you have never emailed should still outrank a cold lead.
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";

const router = Router();

router.get("/", requireAuth, safeHandler(async (req: any, res: any) => {
  const q = String(req.query.q ?? "").trim();
  const limit = Math.min(Number(req.query.limit ?? 10) || 10, 25);
  const silo = resolveSiloFromRequest(req);
  if (q.length < 1) { respondOk(res, { recipients: [] }); return; }

  const like = `%${q}%`;
  const prefix = `${q}%`;

  const sql = `
    WITH staff AS (
      SELECT u.id::text AS id,
             COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS name,
             u.email,
             'staff'::text AS kind,
             NULL::text AS company,
             -- Floor of 500 keeps colleagues above cold contacts without
             -- flattening the ordering among themselves.
             500 AS base_score,
             NULL::timestamptz AS last_at
        FROM users u
       WHERE COALESCE(u.is_active, u.active, true) = true
         AND u.deleted_at IS NULL
         AND COALESCE(u.disabled, false) = false
         AND u.email IS NOT NULL AND TRIM(u.email) <> ''
         AND lower(COALESCE(u.role,'')) IN ('admin','marketing','staff')
         AND (u.email ILIKE $1 OR COALESCE(u.first_name,'') ILIKE $1
              OR COALESCE(u.last_name,'') ILIKE $1
              OR TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) ILIKE $1)
    ),
    contact_volume AS (
      -- How much you have actually corresponded with each contact. This is what
      -- makes the ordering feel right rather than alphabetical.
      SELECT m.contact_id, count(*)::int AS msgs, max(m.created_at) AS last_at
        FROM communications_messages m
       WHERE m.contact_id IS NOT NULL
       GROUP BY m.contact_id
    ),
    people AS (
      SELECT c.id::text AS id,
             COALESCE(NULLIF(TRIM(c.name), ''), c.email) AS name,
             c.email,
             'contact'::text AS kind,
             NULLIF(TRIM(COALESCE(c.company_name, '')), '') AS company,
             COALESCE(v.msgs, 0) AS base_score,
             v.last_at
        FROM contacts c
        LEFT JOIN contact_volume v ON v.contact_id = c.id
       WHERE c.email IS NOT NULL AND TRIM(c.email) <> ''
         AND COALESCE(c.silo, 'BF') = $3
         AND (c.name ILIKE $1 OR c.email ILIKE $1)
    ),
    merged AS (
      SELECT * FROM staff
      UNION ALL
      SELECT * FROM people
    )
    SELECT id, name, email, kind, company,
           base_score
             + CASE WHEN lower(email) = lower($4) THEN 10000 ELSE 0 END
             + CASE WHEN name ILIKE $2 THEN 2000 ELSE 0 END
             + CASE WHEN email ILIKE $2 THEN 1500 ELSE 0 END
             AS score
      FROM merged
     ORDER BY score DESC, last_at DESC NULLS LAST, name ASC
     LIMIT $5`;

  const r = await pool.query(sql, [like, prefix, silo, q, limit]);

  // De-duplicate on email: a staff member who is also a CRM contact should
  // appear once, and the staff row wins because it sorts higher.
  const seen = new Set<string>();
  const recipients = r.rows.filter((row: any) => {
    const k = String(row.email ?? "").toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  respondOk(res, { recipients });
}));

export default router;
