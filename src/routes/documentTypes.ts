import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { AppError } from "../middleware/errors.js";
import { pool } from "../db.js";

const router = Router();

// BF_DOCTYPES_PATH_v34 — Block 34: routes need explicit /document-types path.
// They were declared on "/" while the router is mounted at /api/portal, so
// they collided with the bare /api/portal endpoint and the portal client's
// fetch of /api/portal/document-types 404'd.
// GET /api/portal/document-types — all active types (public to authenticated staff)
router.get("/document-types", safeHandler(async (_req: any, res: any) => {
  const { rows } = await pool.query(
    `SELECT id, key, label, category, sort_order, active
     FROM document_types
     ORDER BY category, sort_order, label`
  );
  res.json({ items: rows });
}));

// POST /api/portal/document-types — admin adds new type
router.post("/document-types", requireAuth, safeHandler(async (req: any, res: any) => {
  const { key, label, category = "core", sort_order = 0 } = req.body ?? {};
  if (!key?.trim() || !label?.trim()) {
    throw new AppError("validation_error", "key and label are required.", 400);
  }
  const { rows } = await pool.query(
    `INSERT INTO document_types (key, label, category, sort_order)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET label = $2, category = $3, updated_at = now()
     RETURNING id, key, label, category, sort_order, active`,
    [key.trim().toLowerCase().replace(/\s+/g, "_"), label.trim(), category, Number(sort_order)]
  );
  res.status(201).json(rows[0]);
}));

// PATCH /api/portal/document-types/:id — toggle active or rename
router.patch("/document-types/:id", requireAuth, safeHandler(async (req: any, res: any) => {
  const { id } = req.params;
  const { label, active } = req.body ?? {};
  const updates: string[] = ["updated_at = now()"];
  const values: unknown[] = [];
  if (label !== undefined) { values.push(label); updates.push(`label = $${values.length}`); }
  if (active !== undefined) { values.push(active); updates.push(`active = $${values.length}`); }
  if (values.length === 0) throw new AppError("validation_error", "Nothing to update.", 400);
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE document_types SET ${updates.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) throw new AppError("not_found", "Document type not found.", 404);
  res.json(rows[0]);
}));

export default router;
