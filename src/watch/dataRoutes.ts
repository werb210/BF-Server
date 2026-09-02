import { Router } from "express";
import { pool } from "../db.js";
import { allowedLine, watchAuth, watchError } from "./security.js";

const router = Router();
router.use(watchAuth);
const bounded = (value: unknown, fallback: number, max: number) => Math.max(1, Math.min(max, Number.parseInt(String(value || fallback), 10) || fallback));

router.get("/contacts", async (req, res) => {
  const requested = String(req.query.line || "").toUpperCase();
  const line = allowedLine(req, requested);
  if (!line) return watchError(req, res, ["BF", "BI", "SLF"].includes(requested) ? 403 : 400,
    ["BF", "BI", "SLF"].includes(requested) ? "forbidden" : "invalid_request", "Line is invalid or not permitted");
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  if (q.length < 2) return watchError(req, res, 400, "invalid_request", "Search query must contain at least two characters");
  const limit = bounded(req.query.limit, 10, 25);
  const cursor = typeof req.query.cursor === "string" && /^[0-9a-f-]{36}$/i.test(req.query.cursor) ? req.query.cursor : null;
  const found = await pool.query(
    `SELECT id::text,name,company_name AS company,phone AS "primaryPhone" FROM contacts
      WHERE silo=$1 AND ($2::uuid IS NULL OR id>$2::uuid)
        AND (name ILIKE '%'||$3||'%' OR company_name ILIKE '%'||$3||'%' OR phone ILIKE '%'||$3||'%')
        AND phone IS NOT NULL ORDER BY id ASC LIMIT $4`, [line, cursor, q, limit + 1]);
  const more = found.rows.length > limit;
  const items = found.rows.slice(0, limit);
  return res.json({ items, nextCursor: more ? items.at(-1)?.id : null });
});

router.get("/calls/recent", async (req: any, res) => {
  const requested = String(req.query.line || "").toUpperCase();
  const line = allowedLine(req, requested);
  if (!line) return watchError(req, res, ["BF", "BI", "SLF"].includes(requested) ? 403 : 400,
    ["BF", "BI", "SLF"].includes(requested) ? "forbidden" : "invalid_request", "Line is invalid or not permitted");
  const limit = bounded(req.query.limit, 25, 50);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
  const found = await pool.query(
    `SELECT cl.id::text AS id,cl.phone_number AS number,c.name AS "contactName",cl.direction,
            cl.created_at AS "occurredAt",cl.silo AS line,cl.status
       FROM call_logs cl LEFT JOIN contacts c ON c.id=cl.crm_contact_id AND c.silo=cl.silo
      WHERE cl.staff_user_id=$1 AND cl.silo=$2 AND ($3::timestamptz IS NULL OR cl.created_at<$3::timestamptz)
      ORDER BY cl.created_at DESC,cl.id DESC LIMIT $4`, [req.watch.staffUserId, line, cursor, limit + 1]);
  const more = found.rows.length > limit;
  const items = found.rows.slice(0, limit);
  return res.json({ items, nextCursor: more ? new Date(items.at(-1).occurredAt).toISOString() : null });
});

export default router;

