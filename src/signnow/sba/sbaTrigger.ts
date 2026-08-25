// BF_SERVER_SBA_TRIGGER_v97
// Everything for SBA signing was built by v95/v96 and nothing ever called it:
// createSbaSigningSessions had no caller, so no applicant was ever sent a link,
// the dispatch gate blocked forever and no package could ship. This is the
// missing trigger.
//
// Two ways in, deliberately:
//   1. automatic - when the last required SBA form is submitted
//   2. manual    - a staff route, for re-sending or for a deal where staff want
//                  to review the answers before a federal form goes out
import { dbQuery } from "../../db.js";
import { createSbaSigningSessions } from "./sbaSigning.js";
import { resolveSbaOwners } from "./sbaOwners.js";
import { logInfo } from "../../observability/logger.js";

/** Is this an SBA deal at all? Non-SBA applications must not be gated. */
export async function isSbaApplication(applicationId: string): Promise<boolean> {
  const r = await dbQuery<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM application_lender_selections s
       JOIN lender_products p ON p.id::text = s.lender_product_id::text
      WHERE s.application_id::text = ($1)::text
        AND upper(COALESCE(p.type,'')) IN ('SBA','SBA_GOVERNMENT')`,
    [applicationId],
  ).catch(() => ({ rows: [{ n: "0" }] }));
  if (Number(r.rows[0]?.n ?? 0) > 0) return true;

  // Fallback for an application that has not been matched to a product yet:
  // the wizard records the SBA / Start-up purpose on the kyc slice.
  const a = await dbQuery<{ purpose: string | null }>(
    `SELECT metadata->'kyc'->>'purposeOfFunds' AS purpose
       FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId],
  ).catch(() => ({ rows: [] as Array<{ purpose: string | null }> }));
  const p = String(a.rows[0]?.purpose ?? "").toLowerCase();
  return p.includes("sba") || p.includes("start up") || p.includes("start-up");
}

/** Which SBA forms must be in before signing can open. */
export async function sbaFormsComplete(applicationId: string): Promise<{ complete: boolean; missing: string[] }> {
  const owners = await resolveSbaOwners(applicationId);
  const required = ["sba_form_1919", ...owners.map((o) => (o.index <= 1 ? "sba_form_413" : `sba_form_413_owner_${o.index}`))];
  const r = await dbQuery<{ doc_type: string }>(
    `SELECT doc_type FROM application_form_responses
      WHERE application_id::text = ($1)::text AND submitted_at IS NOT NULL`,
    [applicationId],
  ).catch(() => ({ rows: [] as Array<{ doc_type: string }> }));
  const have = new Set(r.rows.map((x) => String(x.doc_type)));
  const missing = required.filter((k) => !have.has(k));
  return { complete: missing.length === 0, missing };
}

/** Open signing if, and only if, everything is in and nothing is open already. */
export async function maybeStartSbaSigning(applicationId: string): Promise<{
  started: boolean; reason?: string; links?: Array<{ ownerIndex: number; name: string; email: string; url: string | null }>;
}> {
  if (!(await isSbaApplication(applicationId))) return { started: false, reason: "not_sba" };
  const existing = await dbQuery<{ n: string }>(
    `SELECT COALESCE(jsonb_array_length(metadata->'sba_signnow'), 0)::text AS n
       FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId],
  ).catch(() => ({ rows: [{ n: "0" }] }));
  if (Number(existing.rows[0]?.n ?? 0) > 0) return { started: false, reason: "already_sent" };
  const { complete, missing } = await sbaFormsComplete(applicationId);
  if (!complete) return { started: false, reason: `waiting_on:${missing.join(",")}` };
  const links = await createSbaSigningSessions(applicationId);
  logInfo("sba_signing_started", { applicationId, envelopes: links.length });
  return { started: true, links };
}

/** Force a fresh set of envelopes. Used by the staff re-send route. */
export async function restartSbaSigning(applicationId: string) {
  await dbQuery(
    `UPDATE applications SET metadata = metadata - 'sba_signnow', updated_at = now()
      WHERE id::text = ($1)::text`,
    [applicationId],
  ).catch(() => {});
  return createSbaSigningSessions(applicationId);
}
