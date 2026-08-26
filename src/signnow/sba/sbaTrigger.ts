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
import { resolveSbaOwners, ownerFingerprint } from "./sbaOwners.js";
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
  const r = await dbQuery<{ doc_type: string; owner_fingerprint: string | null }>(
    `SELECT doc_type, owner_fingerprint FROM application_form_responses
      WHERE application_id::text = ($1)::text AND submitted_at IS NOT NULL`,
    [applicationId],
  ).catch(() => ({ rows: [] as Array<{ doc_type: string; owner_fingerprint: string | null }> }));

  // BF_SERVER_SBA_OWNER_IDENTITY_v104
  // A submitted 413 counts only if it was filled for the owner who currently
  // holds that position. Owner indices are positional, so a shareholder added or
  // removed mid-flow shifts everyone below and would otherwise hand one owner's
  // personal financial statement to another. A response with no fingerprint
  // predates this and is accepted as-is rather than forcing a re-ask.
  const expected = new Map<string, string>();
  for (const o of owners) {
    expected.set(o.index <= 1 ? "sba_form_413" : `sba_form_413_owner_${o.index}`, ownerFingerprint(o));
  }

  const have = new Set<string>();
  for (const row of r.rows) {
    const key = String(row.doc_type);
    const want = expected.get(key);
    const got = row.owner_fingerprint ? String(row.owner_fingerprint) : null;
    if (want && got && want !== got) {
      logInfo("sba_form_owner_changed", { applicationId, docType: key });
      continue;
    }
    have.add(key);
  }
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
