// BF_SERVER_LENDER_RESEND_v797
// "Resend" on the Lenders tab: send the current package again to a lender that already received it - typically
// after the client signed again. Normal Send skips lenders that already have the package, so this is the only
// way to get them the updated signed documents. Same holds as a normal send: the application must be signed,
// and for an SBA file the SBA forms, 4506-C and documents must be complete.
import type { Pool } from "pg";

export type ResendResult = { ok: true; sentTo: string[] } | { ok: false; reason: string; detail?: string };

export async function resendPackageToLender(ctx: { pool: Pool; applicationId: string }, lenderId: string): Promise<ResendResult> {
  const { readReadinessSnapshot } = await import("./orchestrator.js");
  const snap = await readReadinessSnapshot(ctx);
  if (!snap.applicationSigned) return { ok: false, reason: "application_not_signed" };
  const { sbaPackageBlocker } = await import("../../signnow/sba/sbaPackageReadiness.js");
  const block = await sbaPackageBlocker(ctx.applicationId);
  if (block) return { ok: false, reason: block.reason, ...(block.detail ? { detail: block.detail } : {}) };

  const prior = await ctx.pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM application_packages
      WHERE application_id::text = $1 AND lender_id::text = $2 AND status = 'sent'`,
    [ctx.applicationId, lenderId],
  );
  if (Number(prior.rows[0]?.n ?? 0) === 0) return { ok: false, reason: "not_sent_before" };

  const lender = await ctx.pool.query<{ lender_id: string; name: string; submission_method: string | null; submission_email: string | null; api_endpoint: string | null; api_key_encrypted: string | null; google_sheet_id: string | null; google_sheet_tab: string | null }>(
    `SELECT l.id::text AS lender_id, l.name, l.submission_method, l.submission_email, l.api_endpoint, l.api_key_encrypted, l.google_sheet_id, l.google_sheet_tab
       FROM lenders l WHERE l.id::text = $1 LIMIT 1`,
    [lenderId],
  );
  if (!lender.rows[0]) return { ok: false, reason: "lender_not_found" };

  // Same lock as a normal send, so a resend never overlaps another dispatch of this file.
  const claim = await ctx.pool.query<{ id: string }>(
    `UPDATE applications SET submission_packages_started_at = NOW()
      WHERE id::text = $1 AND (submission_packages_started_at IS NULL OR submission_packages_started_at < NOW() - interval '10 minutes')
      RETURNING id`,
    [ctx.applicationId],
  );
  if (!claim.rows.length) return { ok: false, reason: "dispatch_in_progress" };
  try {
    const { dispatchToSelected } = await import("../lenders/dispatchToSelected.js");
    const sentTo = (await dispatchToSelected(ctx as any, [lender.rows[0]])) ?? [];
    if (!sentTo.length) return { ok: false, reason: "dispatch_failed" };
    console.log("[lender_resend] package sent again", { applicationId: ctx.applicationId, lenderId });
    return { ok: true, sentTo };
  } catch (err) {
    console.warn("[lender_resend] dispatch failed", { applicationId: ctx.applicationId, lenderId, message: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "dispatch_failed", detail: err instanceof Error ? err.message.slice(0, 200) : undefined };
  } finally {
    await ctx.pool.query(`UPDATE applications SET submission_packages_started_at = NULL WHERE id::text = $1`, [ctx.applicationId])
      .catch((err: unknown) => { console.warn("[lender_resend] lock release failed", { applicationId: ctx.applicationId, message: err instanceof Error ? err.message : String(err) }); });
  }
}
