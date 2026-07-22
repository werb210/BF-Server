// BF_SERVER_v74_BLOCK_1_7 — submission lifecycle orchestrator.
import type { Pool } from "pg";
export type OrchestratorContext = { pool: Pool; applicationId: string; };
export type ReadinessSnapshot = { allDocsAccepted: boolean; allTasksComplete: boolean; lenderSelectionsFinalized: boolean; creditSummarySubmitted: boolean; applicationSigned: boolean; collateralRequired: boolean; collateralComplete: boolean; };
export async function readReadinessSnapshot(ctx: OrchestratorContext): Promise<ReadinessSnapshot> {
  const id = ctx.applicationId; const pool = ctx.pool;
  const docCheck = await pool.query<{ blocked: boolean }>(`SELECT EXISTS (SELECT 1 FROM document_requirements dr WHERE dr.application_id::text = $1 AND dr.required = true AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.application_id::text = dr.application_id::text AND d.category = dr.category AND d.status = 'accepted')) AS blocked`, [id]).catch(() => ({ rows: [{ blocked: false }] }));
  const taskCheck = await pool.query<{ open_count: string }>(`SELECT COUNT(*)::text AS open_count FROM application_tasks WHERE application_id::text = $1 AND completed_at IS NULL`, [id]).catch(() => ({ rows: [{ open_count: "0" }] }));
  const sel = await pool.query<{ finalized_at: string | null }>(`SELECT MAX(finalized_at) AS finalized_at FROM application_lender_selections WHERE application_id::text = $1`, [id]).catch(() => ({ rows: [{ finalized_at: null as string | null }] }));
  // BF_SERVER_BLOCK_v142_ORCHESTRATOR_COLUMN_NAMES_v1 — previously read
  // credit_summary_submitted_at and signed_at, neither of which exist.
  // Real columns: credit_summary_completed_at (stamped by creditSummary.repo)
  // and signnow_app_signed_at (stamped by the SignNow webhook after v141).
  // BF_SERVER_CREDIT_SUMMARY_UNDER_500K_v1 — also load requested_amount so we can waive the
  // credit-summary requirement for applications under $500,000.
  const app = await pool.query<{ credit_summary_completed_at: string | null; signnow_app_signed_at: string | null; requested_amount: string | number | null; }>(`SELECT credit_summary_completed_at, signnow_app_signed_at, requested_amount FROM applications WHERE id::text = $1`, [id]).catch(() => ({ rows: [] as Array<{ credit_summary_completed_at: string | null; signnow_app_signed_at: string | null; requested_amount: string | number | null }> }));
  const docsBlocked = Boolean(docCheck.rows[0]?.blocked ?? false);
  const openTasks = Number(taskCheck.rows[0]?.open_count ?? "0");
  const finalizedAt = sel.rows[0]?.finalized_at ?? null;
  const appRow = app.rows[0];
  // BF_SERVER_BLOCK_v697_COLLATERAL_GATE_v1 — Accord requires the Collateral &
  // Facility section. collateralRequired = an Accord lender is in the finalized
  // selection; collateralComplete = the collateral_facility form has at least one
  // included class with a value.
  // BF_SERVER_COLLATERAL_LOC_ONLY_v1 — Collateral & Facility is an Accord LOC requirement ONLY.
  // Require it iff a SELECTED product is both an Accord-lender product AND category = 'LOC'.
  // lender_submissions.lender_id holds the selected lender_product_id (see portal Send).
  const collateralReqRes = await pool.query<{ accord: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM lender_submissions ls
         JOIN lender_products lp ON lp.id::text = ls.lender_id::text
         JOIN lenders l ON l.id::text = lp.lender_id::text
        WHERE ls.application_id::text = $1
          AND lp.category = 'LOC'
          AND l.name ILIKE '%accord%'
     ) AS accord`,
    [id]
  ).catch(() => ({ rows: [{ accord: false }] }));
  const collateralDoneRes = await pool.query<{ complete: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM application_form_responses
       WHERE application_id::text = $1 AND doc_type = 'collateral_facility'
         AND EXISTS (
           SELECT 1 FROM jsonb_each(COALESCE(data->'classes','{}'::jsonb)) AS cls(key, val)
           WHERE COALESCE((val->>'included')::boolean, false) = true
             AND COALESCE(val->>'value','') <> ''
         )
     ) AS complete`,
    [id]
  ).catch(() => ({ rows: [{ complete: false }] }));
  // BF_SERVER_CREDIT_SUMMARY_UNDER_500K_v1 — applications with a requested amount strictly
  // under $500,000 do not require a completed credit summary. Missing/unparseable amounts are
  // treated as NOT waived (credit summary still required), to stay conservative.
  const reqAmtNum = appRow?.requested_amount == null ? NaN : Number(appRow.requested_amount);
  const creditSummaryWaived = Number.isFinite(reqAmtNum) && reqAmtNum < 500000;
  return { allDocsAccepted: !docsBlocked, allTasksComplete: openTasks === 0, lenderSelectionsFinalized: finalizedAt !== null, creditSummarySubmitted: Boolean(appRow?.credit_summary_completed_at) || creditSummaryWaived, applicationSigned: Boolean(appRow?.signnow_app_signed_at), collateralRequired: Boolean(collateralReqRes.rows[0]?.accord ?? false) && Number.isFinite(reqAmtNum) && reqAmtNum > 250000 /* BF_SERVER_BLOCK_v_COLLATERAL_THRESHOLD_v1: Accord LOC needs collateral only above $250k */, collateralComplete: Boolean(collateralDoneRes.rows[0]?.complete ?? false) };
}
export async function maybeStartCreditSummaryAndSign(ctx: OrchestratorContext): Promise<{ fired: boolean; reason?: string }> {
  const snap = await readReadinessSnapshot(ctx);
  if (!snap.allDocsAccepted || !snap.allTasksComplete || !snap.lenderSelectionsFinalized) return { fired: false, reason: "preconditions_not_met" };
  // BF_SERVER_BLOCK_v697_COLLATERAL_GATE_v1 — Accord requires the Collateral &
  // Facility section filled before SignNow fires (otherwise the envelope/package
  // would go out with empty collateral fields).
  if (snap.collateralRequired && !snap.collateralComplete) return { fired: false, reason: "collateral_incomplete" };
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
  // BF_SERVER_SIGNNOW_GROUP_FIRE_v1 — fire the embedded document-GROUP signing path
  // (fieldextract signature fields; Boreal application + Accord form; Owner 1 / Owner 2 roles;
  // signnow_document_id = group id, which the webhook matches on group-signed events) in REAL
  // mode. The legacy single-document path produced a field-less document and is kept only for
  // stub / unconfigured environments (its stub auto-sign keeps the test pipeline moving).
  // BF_SERVER_BLOCK_v_SIGNING_HARDENING_v1 — if the SignNow fire does not actually start
  // (error/not_ready, or a thrown exception), RELEASE the chain claim so a later Send /
  // auto-trigger can retry. Without this, a failed first fire leaves
  // submission_chain_started_at set and every retry returns "already_started" — the app
  // is permanently wedged in "Ready to sign".
  let signFailReason: string | null = null;
  try {
    const hasKey = (process.env.SIGNNOW_API_KEY ?? "").trim().length > 0;
    const stub = ["1", "true", "yes", "on"].includes((process.env.SIGNNOW_STUB_MODE ?? "").trim().toLowerCase());
    if (hasKey && !stub) {
      const pthG = "../../signnow/embeddedSigningSession.js";
      const mod = await import(pthG).catch(() => null as any);
      if (mod && typeof (mod as any).getOrCreateEmbeddedSigningSession === "function") {
        const r = await (mod as any).getOrCreateEmbeddedSigningSession(ctx.applicationId);
        if (r && (r.status === "error" || r.status === "not_ready")) { signFailReason = String(r.reason ?? r.status); console.warn(`[orchestrator] signnow group fire did not start app=${ctx.applicationId}: ${signFailReason}`); }
      } else { console.log(`[orchestrator] would fire SignNow group for app=${ctx.applicationId}`); }
    } else {
      const pthL = "../../signnow/sendApplicationForSignature.js";
      const mod = await import(pthL).catch(() => null as any);
      if (mod && typeof (mod as any).sendApplicationForSignature === "function") await (mod as any).sendApplicationForSignature(ctx);
      else console.log(`[orchestrator] would fire SignNow (stub) for app=${ctx.applicationId}`);
    }
  } catch (e) { signFailReason = e instanceof Error ? e.message : "signnow_fire_failed"; console.warn("[orchestrator] signnow fire failed", e); }
  if (signFailReason) {
    await ctx.pool.query(`UPDATE applications SET submission_chain_started_at = NULL WHERE id::text = $1`, [ctx.applicationId]).catch(() => {});
    return { fired: false, reason: signFailReason };
  }
  return { fired: true };
}
export async function maybeBuildAndSendPackage(ctx: OrchestratorContext): Promise<{ fired: boolean; reason?: string; sentTo?: string[] }> {
  const snap = await readReadinessSnapshot(ctx);
  if (!snap.creditSummarySubmitted || !snap.applicationSigned) return { fired: false, reason: "not_ready" };
  // BF_SERVER_BLOCK_v310_SUBMISSION_PACKAGE_RACE_CLAIM_v1
  // Pre-fix used SELECT-then-dispatch which races: two concurrent staff
  // "Send to lenders" clicks both saw 0 application_packages rows and both
  // sent (duplicate emails to lenders, two application_packages rows per
  // lender). Atomic claim via UPDATE...WHERE IS NULL RETURNING id mirrors
  // the stageA v179 pattern. If RETURNING is empty, another caller has
  // already started the dispatch — bail without firing a second send.
  // BF_SERVER_INCREMENTAL_LENDER_SEND_v1
  // Pre-fix, submission_packages_started_at was a PERMANENT one-shot flag on the
  // application: the first successful dispatch set it and nothing ever cleared it,
  // so every later Send returned "already_sent" and silently did nothing. Staff
  // could not send to additional lenders after the first batch without a manual
  // DB edit.
  //
  // It is now a short-lived CONCURRENCY LOCK. Duplicate protection lives where it
  // belongs - per lender - via the selection filter below plus the unique index on
  // application_packages(application_id, lender_id) and the lender_sheet_dispatches
  // primary key. The stale window lets a crashed dispatch recover on its own instead
  // of wedging the application forever.
  const LOCK_STALE_MINUTES = 10;
  const claim = await ctx.pool
    .query<{ id: string }>(
      `UPDATE applications
          SET submission_packages_started_at = NOW()
        WHERE id::text = $1
          AND (submission_packages_started_at IS NULL
               OR submission_packages_started_at < NOW() - ($2 || ' minutes')::interval)
        RETURNING id`,
      [ctx.applicationId, String(LOCK_STALE_MINUTES)]
    )
    .catch(() => ({ rows: [] as Array<{ id: string }> }));
  if (!claim.rows.length) {
    // Another caller holds the lock right now. Never a permanent state.
    return { fired: false, reason: "dispatch_in_progress" };
  }
  const sel = await ctx.pool.query<{ lender_id: string; name: string; submission_method: string | null; submission_email: string | null; api_endpoint: string | null; api_key_encrypted: string | null; google_sheet_id: string | null; google_sheet_tab?: string | null; }>(`SELECT s.lender_id, l.name, l.submission_method, l.submission_email, l.api_endpoint, l.api_key_encrypted, l.google_sheet_id, l.google_sheet_tab FROM application_lender_selections s JOIN lenders l ON l.id::text = s.lender_id::text WHERE s.application_id::text = $1 AND NOT EXISTS (SELECT 1 FROM application_packages p WHERE p.application_id::text = s.application_id::text AND p.lender_id::text = s.lender_id::text AND p.status = 'sent') ORDER BY s.position NULLS LAST, s.created_at`, [ctx.applicationId]);
  if (sel.rows.length === 0) {
    // BF_SERVER_INCREMENTAL_LENDER_SEND_v1 - release the lock, then distinguish
    // "never had any selections" from "every selected lender already received the
    // package". The latter is the normal no-op when staff re-press Send without
    // adding anyone new.
    await ctx.pool.query(`UPDATE applications SET submission_packages_started_at = NULL WHERE id::text = $1`, [ctx.applicationId]).catch(() => {});
    const anySel = await ctx.pool
      .query<{ id: string }>(`SELECT id FROM application_lender_selections WHERE application_id::text = $1 LIMIT 1`, [ctx.applicationId])
      .catch(() => ({ rows: [] as Array<{ id: string }> }));
    return { fired: false, reason: anySel.rows.length > 0 ? "already_sent" : "no_selected_lenders" };
  }
  let sentTo: string[] = [];
  let dispatchErr: unknown = null;
  try { const mod = await import("../lenders/dispatchToSelected.js").catch(() => null); if (mod && typeof (mod as any).dispatchToSelected === "function") sentTo = (await (mod as any).dispatchToSelected(ctx, sel.rows)) ?? []; else { console.log(`[orchestrator] would send package to ${sel.rows.length} lenders for app=${ctx.applicationId}`); sentTo = sel.rows.map((r) => r.lender_id);} } catch (e) { dispatchErr = e; console.error("[orchestrator] dispatch failed", e); }
  // BF_SERVER_BLOCK_v310_SUBMISSION_PACKAGE_RACE_CLAIM_v1
  // If dispatch produced zero application_packages rows (total failure or
  // exception before any INSERT ran), release the claim so a manual retry
  // is possible. The NOT EXISTS guard avoids releasing on partial success.
  // BF_SERVER_INCREMENTAL_LENDER_SEND_v1 - the lock is released on EVERY exit path,
  // success or failure. Leaving it set was what blocked all later sends. Re-dispatch
  // to an already-sent lender is prevented by the selection filter above, not by
  // this flag.
  await ctx.pool
    .query(`UPDATE applications SET submission_packages_started_at = NULL WHERE id::text = $1`, [ctx.applicationId])
    .catch(() => {});
  if (dispatchErr) return { fired: false, reason: "dispatch_failed" };
  // BF_SERVER_BLOCK_v722_OFF_TO_LENDER_FIX — package actually dispatched to the
  // selected lender(s): now advance to "Off to Lender".
  await ctx.pool.query(
    `UPDATE applications SET pipeline_state = 'Off to Lender', updated_at = now()
      WHERE id::text = $1
        AND pipeline_state NOT IN ('Off to Lender','Offer','Accepted','Rejected','Declined','Funded','Closed')`,
    [ctx.applicationId]
  ).catch(() => {});
  return { fired: true, sentTo };
}
export async function progressSubmission(ctx: OrchestratorContext): Promise<{ stageA: { fired: boolean; reason?: string }; stageB: { fired: boolean; reason?: string; sentTo?: string[] } }> { const stageA = await maybeStartCreditSummaryAndSign(ctx); const stageB = await maybeBuildAndSendPackage(ctx); return { stageA, stageB }; }
