import express from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { respondOk } from "../../utils/respondOk.js";
// BF_SERVER_BLOCK_BI_ROUND5_CRM_SILO_RESOLVE_v1
import { resolveSiloFromRequest } from "../../middleware/silo.js";

const router = express.Router();

router.get("/", safeHandler(async (req: any, res: any) => {
  const role = (req.user?.role ?? "").toString();
  const silo = resolveSiloFromRequest(req);
  const { rows: shared } = await pool.query(
    `SELECT address, display_name FROM shared_mailbox_settings
     WHERE silo = $1 AND $2 = ANY(allowed_roles)
     ORDER BY display_name`,
    [silo, role],
  );

  const userId = req.user?.id ?? req.user?.userId;
  let mine: { address: string; display_name: string } | null = null;
  if (userId) {
    const { rows } = await pool.query(
      `SELECT email, COALESCE(first_name || ' ' || last_name, email) AS name
       FROM users WHERE id = $1`, [userId]);
    if (rows[0]?.email) mine = { address: rows[0].email, display_name: rows[0].name };
  }

  respondOk(res, { mine, shared });
}));

// BF_SERVER_BLOCK_v824_PER_ACCOUNT_SIGNATURE
// GET /api/crm/shared-mailboxes/:address/signature
router.get("/:address/signature", safeHandler(async (req: any, res: any) => {
  const role = (req.user?.role ?? "").toString();
  const silo = resolveSiloFromRequest(req);
  const address = String(req.params.address ?? "").toLowerCase();
  const { rows } = await pool.query(
    `SELECT signature_html FROM shared_mailbox_settings
      WHERE LOWER(address) = $1 AND silo = $2 AND $3 = ANY(allowed_roles) LIMIT 1`,
    [address, silo, role],
  );
  if (!rows.length) return res.status(404).json({ error: "mailbox_not_found_or_not_allowed" });
  respondOk(res, { address, signature_html: rows[0].signature_html ?? "" });
}));

// PUT /api/crm/shared-mailboxes/:address/signature  body: { signature_html }
router.put("/:address/signature", safeHandler(async (req: any, res: any) => {
  const role = (req.user?.role ?? "").toString();
  const silo = resolveSiloFromRequest(req);
  const address = String(req.params.address ?? "").toLowerCase();
  const html = typeof req.body?.signature_html === "string" ? req.body.signature_html : "";
  const { rows } = await pool.query(
    `SELECT 1 FROM shared_mailbox_settings
      WHERE LOWER(address) = $1 AND silo = $2 AND $3 = ANY(allowed_roles) LIMIT 1`,
    [address, silo, role],
  );
  if (!rows.length) return res.status(403).json({ error: "mailbox_not_allowed" });
  await pool.query(
    `UPDATE shared_mailbox_settings SET signature_html = $3 WHERE LOWER(address) = $1 AND silo = $2`,
    [address, silo, html],
  );
  respondOk(res, { address, signature_html: html });
}));

export default router;
