// BF_SERVER_BLOCK_TWO_STAGE_v1
// Application form responses -- read / upsert / submit for the
// post-submit digital forms (Stage 2 docs that have a form template
// on the client side: PNW and Debt Stack today).
//
// Mounted at /api/portal by the route registry.
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router: Router = Router();

// GET /applications/:id/form-responses
// Returns every form response the applicant has saved or submitted
// for this application. Used by the mini-portal's Stage 2 page to
// hydrate the form list.
router.get("/applications/:id/form-responses", requireAuth, async (req: Request, res: Response) => {
  const appId = String(req.params.id);
  try {
    const r = await pool.query(
      `SELECT id, doc_type, data, submitted_at, created_at, updated_at
         FROM application_form_responses
        WHERE application_id = $1
        ORDER BY updated_at DESC`,
      [appId],
    );
    return res.json({ items: r.rows });
  } catch (err) {
    console.error("[form_responses.list] failed", err);
    return res.status(500).json({ error: "internal" });
  }
});

// GET /applications/:id/form-responses/:doc_type
// Returns a single form response. 404 if not yet started.
router.get("/applications/:id/form-responses/:doc_type", requireAuth, async (req: Request, res: Response) => {
  const appId = String(req.params.id);
  const docType = String(req.params.doc_type);
  try {
    const r = await pool.query(
      `SELECT id, doc_type, data, submitted_at, created_at, updated_at
         FROM application_form_responses
        WHERE application_id = $1 AND doc_type = $2
        LIMIT 1`,
      [appId, docType],
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    return res.json({ item: r.rows[0] });
  } catch (err) {
    console.error("[form_responses.get] failed", err);
    return res.status(500).json({ error: "internal" });
  }
});

// PUT /applications/:id/form-responses/:doc_type
// Autosave. UPSERT into application_form_responses. Does NOT touch
// submitted_at -- saves keep the form in draft.
router.put("/applications/:id/form-responses/:doc_type", requireAuth, async (req: Request, res: Response) => {
  const appId = String(req.params.id);
  const docType = String(req.params.doc_type);
  const data = req.body?.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return res.status(400).json({ error: "data must be an object" });
  }
  try {
    const r = await pool.query(
      `INSERT INTO application_form_responses (application_id, doc_type, data, updated_at)
            VALUES ($1, $2, $3::jsonb, NOW())
            ON CONFLICT (application_id, doc_type)
            DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
         RETURNING id, doc_type, data, submitted_at, created_at, updated_at`,
      [appId, docType, JSON.stringify(data)],
    );
    return res.json({ item: r.rows[0] });
  } catch (err) {
    console.error("[form_responses.upsert] failed", err);
    return res.status(500).json({ error: "internal" });
  }
});

// POST /applications/:id/form-responses/:doc_type/submit
// Finalize. Sets submitted_at = NOW(). Idempotent: re-submit just
// updates the timestamp. data, if provided, overwrites the current
// row -- so the client can do save+submit in one call.
router.post("/applications/:id/form-responses/:doc_type/submit", requireAuth, async (req: Request, res: Response) => {
  const appId = String(req.params.id);
  const docType = String(req.params.doc_type);
  const data = req.body?.data;
  const hasData = data && typeof data === "object" && !Array.isArray(data);
  try {
    const r = hasData
      ? await pool.query(
          `INSERT INTO application_form_responses (application_id, doc_type, data, submitted_at, updated_at)
                VALUES ($1, $2, $3::jsonb, NOW(), NOW())
                ON CONFLICT (application_id, doc_type)
                DO UPDATE SET data = EXCLUDED.data, submitted_at = NOW(), updated_at = NOW()
             RETURNING id, doc_type, data, submitted_at, created_at, updated_at`,
          [appId, docType, JSON.stringify(data)],
        )
      : await pool.query(
          `UPDATE application_form_responses
              SET submitted_at = NOW(), updated_at = NOW()
            WHERE application_id = $1 AND doc_type = $2
            RETURNING id, doc_type, data, submitted_at, created_at, updated_at`,
          [appId, docType],
        );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    return res.json({ item: r.rows[0] });
  } catch (err) {
    console.error("[form_responses.submit] failed", err);
    return res.status(500).json({ error: "internal" });
  }
});

export default router;
