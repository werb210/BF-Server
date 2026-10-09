// BF_SERVER_SBA_PACKAGE_READINESS_v788
// One answer to "may this SBA file go to a lender now?", used by every path that
// ships a package: the staff Send on the Lenders tab (orchestrator stage B) and
// the lender package worker that runs after the last owner signs.
//
// Before this, stage B checked only "application signed" and "credit summary".
// For an SBA file that let a package ship:
//   - with documents still outstanding or client tasks open (an SBA file signs
//     from the SBA Signing tab, so the document gate on the normal signing path
//     never ran);
//   - with no IRS 4506-C at all, or none for the lender it was going to;
//   - after staff pressed Send for signing again, while the fresh envelopes were
//     still unsigned (the old signed stamp stayed set and the package went out
//     with no SBA forms in it).
// Non-SBA files are untouched: this returns null for them.
import { dbQuery } from "../../db.js";
import { isApiKeyConfigured } from "../signnowClient.js";
import { loadIvesLenders, sbaEnvelopes, sbaSigningSatisfiedForDispatch } from "./sbaSigning.js";

export type SbaPackageBlock = { reason: string; detail?: string };

export type SbaPackageInput = {
  isSba: boolean;
  signnowConfigured: boolean;
  docsOutstanding: string[];
  openTasks: number;
  envelopes: Array<{ ives4506cLenderIds?: string[] }>;
  ivesLenders: Array<{ lenderId: string; lenderName: string }>;
  signedForDispatch: boolean;
};

/** True when the single-lender SBA_IVES_* fallback can fill line 5a of a 4506-C. */
export function ivesFallbackConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["SBA_IVES_PARTICIPANT_NAME", "SBA_IVES_PARTICIPANT_ID", "SBA_IVES_SOR_MAILBOX_ID"]
    .every((k) => String(env[k] ?? "").trim() !== "");
}

/** Pure decision. Order matters: the first thing staff can act on wins. */
export function decideSbaPackageBlock(i: SbaPackageInput): SbaPackageBlock | null {
  if (!i.isSba) return null;
  if (i.signnowConfigured && i.envelopes.length === 0) return { reason: "sba_signing_not_started" };
  if (i.docsOutstanding.length > 0 || i.openTasks > 0) {
    const parts: string[] = [];
    if (i.docsOutstanding.length > 0) parts.push(`documents: ${i.docsOutstanding.slice(0, 6).join(", ")}`);
    if (i.openTasks > 0) parts.push(`${i.openTasks} open client task${i.openTasks === 1 ? "" : "s"}`);
    return { reason: "preconditions_not_met", detail: parts.join("; ") };
  }
  if (!i.signnowConfigured) return null;
  const covered = new Set<string>();
  for (const e of i.envelopes) for (const id of e.ives4506cLenderIds ?? []) covered.add(String(id));
  const uncovered = i.ivesLenders.filter((l) => !covered.has(String(l.lenderId)));
  if (uncovered.length > 0) {
    return { reason: "sba_4506c_missing_for_lender", detail: uncovered.map((l) => l.lenderName || l.lenderId).join(", ") };
  }
  if (covered.size === 0) return { reason: "sba_4506c_missing" };
  if (!i.signedForDispatch) return { reason: "sba_forms_not_signed" };
  return null;
}

/** Every lender finalized on the file, and whether it has IVES details for a 4506-C. */
export async function loadSelectedLendersForSba(applicationId: string): Promise<Array<{ lenderId: string; name: string; ives: boolean; offersSba: boolean | null }>> {
  const r = await dbQuery<{ lenderId: string; name: string; ives: boolean; offersSba: boolean | null }>(
    `SELECT l.id::text AS "lenderId", COALESCE(l.name,'') AS name,
            (COALESCE(l.ives_participant_name,'') <> '' AND COALESCE(l.ives_participant_id,'') <> ''
              AND COALESCE(l.ives_sor_mailbox_id,'') <> '') AS ives,
            l.offers_sba AS "offersSba"
       FROM application_lender_selections s
       JOIN lenders l ON l.id::text = s.lender_id::text
      WHERE s.application_id::text = ($1)::text
      ORDER BY s.position NULLS LAST, l.name ASC`,
    [applicationId],
  ).catch((err: any) => { console.warn("[sba_package_readiness] selected lenders query failed", { applicationId, message: err?.message }); return { rows: [] as Array<{ lenderId: string; name: string; ives: boolean; offersSba: boolean | null }> }; });
  return r.rows;
}

/**
 * null = nothing SBA-specific holds this package (or it is not an SBA file).
 * Fails closed: if an SBA file cannot be checked, the package waits.
 */
export async function sbaPackageBlocker(applicationId: string, opts: { signingChecked?: boolean } = {}): Promise<SbaPackageBlock | null> {
  const { isSbaApplication } = await import("./sbaTrigger.js");
  if (!(await isSbaApplication(applicationId))) return null;
  try {
    const { computeOutstandingDocs } = await import("../../routes/clientDocumentsNeeded.js");
    const o = await computeOutstandingDocs(applicationId);
    const docsOutstanding = [...o.stillNeeded, ...o.rejected].map((d) => String(d.label || d.document_type || "document"));
    const t = await dbQuery<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM application_tasks WHERE application_id::text = ($1)::text AND completed_at IS NULL`,
      [applicationId],
    );
    const signnowConfigured = isApiKeyConfigured();
    const envelopes = await sbaEnvelopes(applicationId);
    const ivesLenders = await loadIvesLenders(applicationId);
    const signedForDispatch = opts.signingChecked || !signnowConfigured || envelopes.length === 0
      ? true
      : await sbaSigningSatisfiedForDispatch(applicationId);
    return decideSbaPackageBlock({
      isSba: true, signnowConfigured, docsOutstanding, openTasks: Number(t.rows[0]?.n ?? 0),
      envelopes, ivesLenders, signedForDispatch,
    });
  } catch (err) {
    console.warn("[sba_package_readiness] check failed - holding the package", { applicationId, message: err instanceof Error ? err.message : String(err) });
    return { reason: "sba_check_failed" };
  }
}
