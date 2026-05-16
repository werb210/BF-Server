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

export default router;
