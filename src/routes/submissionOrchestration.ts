// BF_SERVER_BLOCK_v122d_STRIP_DOUBLE_API_v1 — stripped leading /api (router mounted under /api in app.ts)
import { Router } from "express";
import { pool } from "../db.js";
import { progressSubmission } from "../services/submission/orchestrator.js";
import { dispatchToSelected, type DispatchLender } from "../services/lenders/dispatchToSelected.js";

const router = Router();
router.post("/applications/:id/lenders/send", async (req, res) => {
  const id = String(req.params.id ?? "").trim();
  const lenderIds: string[] = Array.isArray((req.body ?? {}).lenderIds) ? (req.body.lenderIds as unknown[]).map((x) => String(x)) : [];
  if (!id) return res.status(400).json({ error: "missing_application_id" });
  if (lenderIds.length === 0) return res.status(400).json({ error: "no_lenders_selected" });

  for (let i = 0; i < lenderIds.length; i++) {
    await pool.query(`INSERT INTO application_lender_selections (id, application_id, lender_id, position, finalized_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
       ON CONFLICT (application_id, lender_id) DO UPDATE
         SET position = EXCLUDED.position, finalized_at = NOW()`, [id, lenderIds[i], i]).catch(() => {});
  }

  const result = await progressSubmission({ pool, applicationId: id });
  const lenders = await pool.query<DispatchLender>(`SELECT id::text AS lender_id, name, submission_method, submission_email,
            api_endpoint, api_key_encrypted, google_sheet_id
       FROM lenders
      WHERE id::text = ANY($1::text[])`, [lenderIds]);
  const sent = await dispatchToSelected({ pool, applicationId: id }, lenders.rows).catch((): string[] => []);
  return res.json({ ok: true, finalized: lenderIds, sent, orchestrator: result });
});

router.post("/applications/:id/submit-trigger-check", async (req, res) => {
  const id = String(req.params.id ?? "").trim();
  if (!id) return res.status(400).json({ error: "missing_application_id" });
  const result = await progressSubmission({ pool, applicationId: id });
  return res.json({ ok: true, ...result });
});
export default router;
