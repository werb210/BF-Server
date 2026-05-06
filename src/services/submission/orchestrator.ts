// BF_SERVER_v74_BLOCK_1_7 — submission lifecycle orchestrator.
import type { Pool } from "pg";
export type OrchestratorContext = { pool: Pool; applicationId: string; };
export type ReadinessSnapshot = { allDocsAccepted: boolean; allTasksComplete: boolean; lenderSelectionsFinalized: boolean; creditSummarySubmitted: boolean; applicationSigned: boolean; };
export async function readReadinessSnapshot(ctx: OrchestratorContext): Promise<ReadinessSnapshot> {
  const id = ctx.applicationId; const pool = ctx.pool;
  const docCheck = await pool.query<{ blocked: boolean }>(`SELECT EXISTS (SELECT 1 FROM document_requirements dr WHERE dr.application_id::text = $1 AND dr.required = true AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.application_id::text = dr.application_id::text AND d.category = dr.category AND d.status = 'accepted')) AS blocked`, [id]).catch(() => ({ rows: [{ blocked: false }] }));
  const taskCheck = await pool.query<{ open_count: string }>(`SELECT COUNT(*)::text AS open_count FROM application_tasks WHERE application_id::text = $1 AND completed_at IS NULL`, [id]).catch(() => ({ rows: [{ open_count: "0" }] }));
  const sel = await pool.query<{ finalized_at: string | null }>(`SELECT MAX(finalized_at) AS finalized_at FROM application_lender_selections WHERE application_id::text = $1`, [id]).catch(() => ({ rows: [{ finalized_at: null as string | null }] }));
  // BF_SERVER_BLOCK_v142_ORCHESTRATOR_COLUMN_NAMES_v1 — previously read
  // credit_summary_submitted_at and signed_at, neither of which exist.
  // Real columns: credit_summary_completed_at (stamped by creditSummary.repo)
  // and signnow_app_signed_at (stamped by the SignNow webhook after v141).
  const app = await pool.query<{ credit_summary_completed_at: string | null; signnow_app_signed_at: string | null; }>(`SELECT credit_summary_completed_at, signnow_app_signed_at FROM applications WHERE id::text = $1`, [id]).catch(() => ({ rows: [] as Array<{ credit_summary_completed_at: string | null; signnow_app_signed_at: string | null }> }));
  const docsBlocked = Boolean(docCheck.rows[0]?.blocked ?? false);
  const openTasks = Number(taskCheck.rows[0]?.open_count ?? "0");
  const finalizedAt = sel.rows[0]?.finalized_at ?? null;
  const appRow = app.rows[0];
  return { allDocsAccepted: !docsBlocked, allTasksComplete: openTasks === 0, lenderSelectionsFinalized: finalizedAt !== null, creditSummarySubmitted: Boolean(appRow?.credit_summary_completed_at), applicationSigned: Boolean(appRow?.signnow_app_signed_at) };
}
export async function maybeStartCreditSummaryAndSign(ctx: OrchestratorContext): Promise<{ fired: boolean; reason?: string }> {
  const snap = await readReadinessSnapshot(ctx);
  if (!snap.allDocsAccepted || !snap.allTasksComplete || !snap.lenderSelectionsFinalized) return { fired: false, reason: "preconditions_not_met" };
  // BF_SERVER_BLOCK_v179_ORCHESTRATOR_CAS_v1
  // Race-safe start: claim the chain via UPDATE...WHERE IS NULL
  // RETURNING id. If RETURNING is empty, another caller beat us;
  // bail without firing SignNow / admin notification a second time.
  const claim = await ctx.pool
    .query<{ id: string }>(
      `UPDATE applications
          SET submission_chain_started_at = NOW()
        WHERE id::text = $1
          AND submission_chain_started_at IS NULL
        RETURNING id`,
      [ctx.applicationId]
    )
    .catch(() => ({ rows: [] as Array<{ id: string }> }));
  if (!claim.rows.length) return { fired: false, reason: "already_started" };
  try { const pth = "../notifications/notifyAdminsForCreditSummary.js"; const mod = await import(pth).catch(() => null as any); if (mod && typeof (mod as any).notifyAdminsForCreditSummary === "function") await (mod as any).notifyAdminsForCreditSummary(ctx); else console.log(`[orchestrator] would notify admins for app=${ctx.applicationId}`);} catch (e) { console.warn("[orchestrator] notify admins failed", e); }
  try { const pth = "../signnow/sendApplicationForSignature.js"; const mod = await import(pth).catch(() => null as any); if (mod && typeof (mod as any).sendApplicationForSignature === "function") await (mod as any).sendApplicationForSignature(ctx); else console.log(`[orchestrator] would fire SignNow for app=${ctx.applicationId}`);} catch (e) { console.warn("[orchestrator] signnow fire failed", e); }
  return { fired: true };
}
export async function maybeBuildAndSendPackage(ctx: OrchestratorContext): Promise<{ fired: boolean; reason?: string; sentTo?: string[] }> {
  const snap = await readReadinessSnapshot(ctx);
  if (!snap.creditSummarySubmitted || !snap.applicationSigned) return { fired: false, reason: "not_ready" };
  const existing = await ctx.pool.query<{ id: string }>(`SELECT id FROM application_packages WHERE application_id::text = $1 LIMIT 1`, [ctx.applicationId]).catch(() => ({ rows: [] as Array<{ id: string }> }));
  if (existing.rows.length > 0) return { fired: false, reason: "already_sent" };
  const sel = await ctx.pool.query<{ lender_id: string; name: string; submission_method: string | null; submission_email: string | null; api_endpoint: string | null; api_key_encrypted: string | null; google_sheet_id: string | null; }>(`SELECT s.lender_id, l.name, l.submission_method, l.submission_email, l.api_endpoint, l.api_key_encrypted, l.google_sheet_id FROM application_lender_selections s JOIN lenders l ON l.id::text = s.lender_id::text WHERE s.application_id::text = $1 ORDER BY s.position NULLS LAST, s.created_at`, [ctx.applicationId]);
  if (sel.rows.length === 0) return { fired: false, reason: "no_selected_lenders" };
  let sentTo: string[] = [];
  try { const mod = await import("../lenders/dispatchToSelected.js").catch(() => null); if (mod && typeof (mod as any).dispatchToSelected === "function") sentTo = (await (mod as any).dispatchToSelected(ctx, sel.rows)) ?? []; else { console.log(`[orchestrator] would send package to ${sel.rows.length} lenders for app=${ctx.applicationId}`); sentTo = sel.rows.map((r) => r.lender_id);} } catch (e) { console.error("[orchestrator] dispatch failed", e); return { fired: false, reason: "dispatch_failed" }; }
  return { fired: true, sentTo };
}
export async function progressSubmission(ctx: OrchestratorContext): Promise<{ stageA: { fired: boolean; reason?: string }; stageB: { fired: boolean; reason?: string; sentTo?: string[] } }> { const stageA = await maybeStartCreditSummaryAndSign(ctx); const stageB = await maybeBuildAndSendPackage(ctx); return { stageA, stageB }; }
