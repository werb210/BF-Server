// BF_SERVER_BLOCK_v153_SLF_BACKEND_MINIMAL_v1
// Minimum viable SLF silo routes. Reads filter applications by silo='SLF';
// writes are accepted but no-op until SLF data model is finalized.

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { AppError } from "../middleware/errors.js";

const router = Router();
router.use(requireAuth);

// POST /api/slf/pipeline — pipeline list filtered to SLF silo
router.post(
  "/pipeline",
  safeHandler(async (_req: any, res: any) => {
    const { rows } = await pool.query(
      `SELECT id, name, pipeline_state AS stage, requested_amount, created_at, updated_at
         FROM applications
        WHERE silo = 'SLF'
        ORDER BY updated_at DESC
        LIMIT 200`,
    );
    res.json({
      stages: [
        { id: "intake", label: "Intake" },
        { id: "review", label: "Review" },
        { id: "approved", label: "Approved" },
        { id: "rejected", label: "Rejected" },
      ],
      applications: rows,
    });
  }),
);

// PATCH /api/slf/pipeline/:id/stage — accept stage update
router.patch(
  "/pipeline/:id/stage",
  safeHandler(async (req: any, res: any) => {
    const id = String(req.params.id ?? "").trim();
    const stage = String(req.body?.stage ?? "").trim();
    if (!id) throw new AppError("validation_error", "Application id required.", 400);
    if (!stage) throw new AppError("validation_error", "Stage required.", 400);
    await pool
      .query(
        `UPDATE applications SET pipeline_state = $1, updated_at = now()
          WHERE id::text = ($2)::text AND silo = 'SLF'`,
        [stage, id],
      )
      .catch(() => {});
    res.json({ ok: true });
  }),
);

// POST /api/slf/pipeline/export — return ids only, defer real export
router.post(
  "/pipeline/export",
  safeHandler(async (req: any, res: any) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="slf-export.csv"');
    res.send("id\n" + ids.join("\n"));
  }),
);

// GET /api/slf/applications/:id
router.get(
  "/applications/:id",
  safeHandler(async (req: any, res: any) => {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw new AppError("validation_error", "Application id required.", 400);
    const { rows } = await pool.query(
      `SELECT * FROM applications
        WHERE id::text = ($1)::text AND silo = 'SLF'
        LIMIT 1`,
      [id],
    );
    if (!rows[0]) throw new AppError("not_found", "Application not found.", 404);
    res.json(rows[0]);
  }),
);

// GET /api/slf/applications/:id/notes
router.get(
  "/applications/:id/notes",
  safeHandler(async (req: any, res: any) => {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw new AppError("validation_error", "Application id required.", 400);
    const { rows } = await pool
      .query(
        `SELECT id, body AS text, created_at FROM application_notes
          WHERE application_id::text = ($1)::text
          ORDER BY created_at DESC`,
        [id],
      )
      .catch(() => ({ rows: [] }));
    res.json(rows);
  }),
);

// POST /api/slf/applications/:id/notes
router.post(
  "/applications/:id/notes",
  safeHandler(async (req: any, res: any) => {
    const id = String(req.params.id ?? "").trim();
    const text = String(req.body?.text ?? "").trim();
    if (!id) throw new AppError("validation_error", "Application id required.", 400);
    if (!text) throw new AppError("validation_error", "Note text required.", 400);
    await pool
      .query(
        `INSERT INTO application_notes (id, application_id, body, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, now(), now())`,
        [id, text],
      )
      .catch(() => {});
    res.status(201).json({ ok: true });
  }),
);

// GET /api/slf/applications/:id/documents
router.get(
  "/applications/:id/documents",
  safeHandler(async (req: any, res: any) => {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw new AppError("validation_error", "Application id required.", 400);
    const { rows } = await pool
      .query(
        `SELECT id, filename, document_type, status, created_at
           FROM documents
          WHERE application_id::text = ($1)::text
          ORDER BY created_at DESC`,
        [id],
      )
      .catch(() => ({ rows: [] }));
    res.json(rows);
  }),
);

export default router;
