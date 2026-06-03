// BF_SERVER_BLOCK_v122d_STRIP_DOUBLE_API_v1 — stripped leading /api (router mounted under /api in app.ts)
import { Router } from "express";
import { pool } from "../db.js";
import { progressSubmission } from "../services/submission/orchestrator.js";
import { readReadinessSnapshot } from "../services/submission/orchestrator.js";
import { dispatchToSelected, type DispatchLender } from "../services/lenders/dispatchToSelected.js";
// BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1 — AUDIT-12 regression repair.
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";

const router = Router();
// BF_SERVER_BLOCK_55_GATE_AND_BANKING_TRIGGER_v1
// Pre-fix: this route INSERTed selections, called progressSubmission
// (which itself dispatches if ready), THEN ALSO called dispatchToSelected
// directly — causing duplicate emails to lenders. It also bypassed the
// readiness gate entirely (any preconditions failure was silently ignored).
// Now: rely on progressSubmission's internal gate. If stageB didn't fire,
// return 409 with a structured reason instead of confirming "sent".
router.post("/lenders/send", requireAuth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }), async (req, res) => {
  const b = req.body ?? {};
  const applicationId = String(b.applicationId ?? b.application_id ?? "").trim();
  const rawLenders = b.lenderIds ?? b.lenders ?? b.lender_ids ?? [];
  const lenderIds: string[] = Array.isArray(rawLenders)
    ? (rawLenders as unknown[]).map((x) => String(x)).filter(Boolean)
    : [];
  if (!applicationId) return res.status(400).json({ error: "missing_application_id" });
  if (lenderIds.length === 0) return res.status(400).json({ error: "no_lenders_selected" });

  for (let i = 0; i < lenderIds.length; i++) {
    await pool.query(`INSERT INTO application_lender_selections (id, application_id, lender_id, position, finalized_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
       ON CONFLICT (application_id, lender_id) DO UPDATE
         SET position = EXCLUDED.position, finalized_at = NOW()`,
      [applicationId, lenderIds[i], i]).catch(() => {});
  }

  const orchestrator = await progressSubmission({ pool, applicationId });

  // BF_SERVER_BLOCK_55_GATE_AND_BANKING_TRIGGER_v1
  // If stageB.fired is false AND no prior packages exist, the gate
  // blocked dispatch. Return 409 with readable readiness reasons so the
  // UI can show the user what's missing instead of a silent no-op.
  if (orchestrator.stageB.fired !== true) {
    const snap = await readReadinessSnapshot({ pool, applicationId });
    const blockers: string[] = [];
    if (!snap.allDocsAccepted) blockers.push("required_documents_not_accepted");
    if (!snap.allTasksComplete) blockers.push("open_tasks_remaining");
    if (snap.collateralRequired && !snap.collateralComplete) blockers.push("collateral_not_complete");
    if (!snap.creditSummarySubmitted) blockers.push("credit_summary_not_submitted");
    if (!snap.applicationSigned) blockers.push("application_not_signed");
    // already_sent / dispatch_in_progress / already_started are valid no-ops, not failures.
    const orchestratorReason = orchestrator.stageB.reason ?? orchestrator.stageA.reason ?? "preconditions_not_met";
    const validNoOp = orchestratorReason === "already_sent" || orchestratorReason === "dispatch_in_progress";
    if (!validNoOp) {
      return res.status(409).json({
        error: "not_ready_to_send",
        reason: orchestratorReason,
        blockers,
        readiness: snap,
        finalized: lenderIds,
      });
    }
  }

  // Selections finalized + (orchestrator either fired this dispatch or a
  // prior one already completed). DO NOT call dispatchToSelected here;
  // maybeBuildAndSendPackage owns the atomic claim + dispatch.
  return res.json({ ok: true, finalized: lenderIds, orchestrator });
});

router.post("/applications/:id/lenders/send", requireAuth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }), async (req, res) => {
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

router.post("/applications/:id/submit-trigger-check", requireAuth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }), async (req, res) => {
  const id = String(req.params.id ?? "").trim();
  if (!id) return res.status(400).json({ error: "missing_application_id" });
  const result = await progressSubmission({ pool, applicationId: id });
  return res.json({ ok: true, ...result });
});
export default router;
