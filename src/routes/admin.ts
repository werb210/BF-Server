import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { adminRateLimit } from "../middleware/rateLimit.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import auditRoutes from "../modules/audit/audit.routes.js";
import lenderAdminRoutes from "../modules/lender/lender.admin.routes.js";
import ocrAdminRoutes from "../modules/ocr/ocr.admin.routes.js";
import adminOpsRoutes from "./admin.ops.js";
import adminExportsRoutes from "./admin.exports.js";
import adminDashboardRoutes from "./admin.dashboard.js";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.AUDIT_VIEW]));
router.use(adminRateLimit());
router.use("/audit", auditRoutes);
router.use("/ops", adminOpsRoutes);
router.use("/exports", adminExportsRoutes);
router.use("/ocr", ocrAdminRoutes);
router.use("/", adminDashboardRoutes);
// BF_SERVER_BLOCK_v221_ADMIN_USERS_LIST_v1
// Staff list for the calendar attendee picker and other admin surfaces.
// Excludes soft-deleted users. Active users only.
router.get("/users", requireCapability([CAPABILITIES.USER_MANAGE]), async (_req: any, res: any) => {
  try {
    const r = await (await import("../db.js")).pool.query<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      role: string | null;
      is_active: boolean;
    }>(
      `SELECT id, first_name, last_name, email, role, is_active
         FROM users
        WHERE COALESCE(is_active, true) = true
          AND deleted_at IS NULL
        ORDER BY COALESCE(NULLIF(TRIM(first_name), ''), email, id::text) ASC
        LIMIT 500`
    );
    const users = r.rows.map((u) => ({
      id: u.id,
      first_name: u.first_name,
      last_name: u.last_name,
      email: u.email,
      role: u.role,
      // Provide a pre-composed name field for clients that don't want
      // to recompose first+last; CalendarPage.tsx uses `name` first.
      name: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || (u.email ?? ""),
    }));
    return res.json({ users });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[admin users list] failed", message);
    return res.status(500).json({ error: "users_list_failed" });
  }
});
router.get("/users/:id", requireCapability([CAPABILITIES.USER_MANAGE]), async (req: any, res: any) => {
  const { rows } = await (await import("../db.js")).pool.query(`SELECT id, email, role, silo, outbound_caller_id FROM users WHERE id = $1 LIMIT 1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "not_found" });
  return res.status(200).json(rows[0]);
});

router.patch("/users/:id", requireCapability([CAPABILITIES.USER_MANAGE]), async (req: any, res: any) => {
  const value = req.body?.outbound_caller_id;
  if (!(value === null || (typeof value === "string" && /^\+[1-9]\d{6,14}$/.test(value)))) return res.status(400).json({ error: "invalid_outbound_caller_id" });
  const { rows } = await (await import("../db.js")).pool.query(`UPDATE users SET outbound_caller_id = $1 WHERE id = $2 RETURNING id, email, role, silo, outbound_caller_id`, [value, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "not_found" });
  return res.status(200).json(rows[0]);
});

router.use("/", lenderAdminRoutes);

// BF_SERVER_BLOCK_vA_REINGEST_PRODUCTS_v1 — rebuild Maya's product knowledge.
// embedAndStore APPENDS (no replace), so we DELETE the prior product rows first
// to avoid duplicate embeddings, then re-ingest all lender_products. Trigger
// once after a product seed. Admin-gated (USER_MANAGE), like sibling /users.
router.post(
  "/reingest-products",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (_req: any, res: any) => {
    try {
      const { pool } = await import("../db.js");
      const { ingestAllProducts } = await import("../modules/ai/productIngest.service.js");
      const del = await pool.query(
        "DELETE FROM ai_knowledge WHERE source_type = 'product' OR source_type LIKE 'product:%'",
      );
      await ingestAllProducts(pool);
      const cnt = await pool.query("SELECT count(*)::int AS n FROM lender_products");
      res.json({ ok: true, deleted: del.rowCount ?? 0, ingested: cnt.rows[0]?.n ?? 0 });
    } catch (e: any) {
      console.error("reingest_products_failed", { message: e?.message });
      res.status(500).json({ ok: false, error: e?.message ?? "reingest_failed" });
    }
  },
);

export default router;
