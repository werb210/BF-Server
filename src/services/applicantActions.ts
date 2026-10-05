// BF_SERVER_APPLICANT_ACTION_CENTER_v197
// BF_SERVER_BLOCK_v544_ACTION_CENTER_MATCHES_REQUEST_ITEMS
// One answer to "what does this applicant still have to do", and the SAME answer
// staff see on the Request Items and Application tabs:
//   forms     = forms staff requested (task prompts in the thread) minus forms
//               staff unchecked on Request Items (form:<id> waivers). A draft
//               form row the client happened to open does NOT make it required.
//   documents = computeOutstandingDocs (the client's upload list, waiver-aware).
import { dbQuery } from "../db.js";

export type ActionItem = {
  key: string;
  kind: "document" | "form" | "action";
  label: string;
  /** BF_SERVER_TODO_PROMPTS_v635 - what the button does, in the client's existing button vocabulary
   * (a URL, "sba_forms", ...). Documents and plain forms leave it empty. */
  action?: string;
  // rejected items come back to the top: the applicant already did the work once
  // and needs to know it was not accepted.
  urgent: boolean;
};

export type ActionCenter = {
  outstanding: ActionItem[];
  completed: ActionItem[];
  outstandingCount: number;
};

type Doc = { document_type: string; label: string };

// The task keys the client wizard and mini-portal already use (v778 vocabulary).
export const FORM_TASKS: Array<{ key: string; label: string; match: RegExp }> = [
  { key: "cra", label: "CRA Authorization", match: /cra/i },
  { key: "networth", label: "Personal Net Worth", match: /net.?worth/i },
  { key: "advisors", label: "Professional Advisors", match: /advisor/i },
  { key: "debt", label: "Debt Stack", match: /debt/i },
  { key: "equipment", label: "Equipment Details", match: /equipment/i },
  { key: "realestate", label: "Real Estate Schedule", match: /real.?estate/i },
  { key: "flinks", label: "Connect Bank (View-Only)", match: /flinks|bank/i },
];

const norm = (s: string): string => String(s ?? "").trim().toLowerCase();

// Pure: everything the list shows is decided here, so it is testable without a
// database.
export function assembleActionCenter(input: {
  requestedForms: string[];
  waivedForms: string[];
  submittedFormTypes: string[];
  required: Doc[];
  stillNeeded: Doc[];
  rejected: Doc[];
  /** BF_SERVER_SBA_FORMS_TODO_v757 - the 20%+ owners on an SBA deal; absent for every other deal. */
  sbaOwners?: Array<{ index: number; name?: string | null }>;
}): ActionCenter {
  const outstanding: ActionItem[] = [];
  const completed: ActionItem[] = [];

  const still = new Set(input.stillNeeded.map((d) => norm(d.document_type)));
  const rejected = new Set(input.rejected.map((d) => norm(d.document_type)));
  const seen = new Set<string>();

  for (const d of input.rejected) {
    const k = norm(d.document_type);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    outstanding.push({ key: `upload:${k}`, kind: "document", label: d.label || d.document_type, urgent: true });
  }
  for (const d of input.required) {
    const k = norm(d.document_type);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const item: ActionItem = { key: `upload:${k}`, kind: "document", label: d.label || d.document_type, urgent: false };
    if (still.has(k) || rejected.has(k)) outstanding.push(item);
    else completed.push(item);
  }
  for (const d of input.stillNeeded) {
    const k = norm(d.document_type);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    outstanding.push({ key: `upload:${k}`, kind: "document", label: d.label || d.document_type, urgent: false });
  }

  const requested = new Set(input.requestedForms.map(norm));
  const waived = new Set(input.waivedForms.map(norm));
  const sba = Array.isArray(input.sbaOwners) && input.sbaOwners.length > 0;
  for (const task of FORM_TASKS) {
    if (!requested.has(task.key) || waived.has(task.key)) continue;
    // BF_SERVER_SBA_FORMS_TODO_v757 - on an SBA deal Form 413 is the personal net worth statement.
    if (sba && task.key === "networth") continue;
    const done = input.submittedFormTypes.some((t) => task.match.test(t));
    const item: ActionItem = { key: `form:${task.key}`, kind: "form", label: task.label, urgent: false };
    if (done) completed.push(item);
    else outstanding.push(item);
  }

  // BF_SERVER_SBA_FORMS_TODO_v757 - every SBA deal lists Form 1919 and a Form 413 for each 20%+ owner
  // automatically; they open the SBA Forms page. Previously they only appeared, as one "SBA forms" line,
  // after staff sent a request.
  if (sba) {
    const submitted = new Set(input.submittedFormTypes.map(norm));
    const add = (docType: string, label: string) => {
      const item: ActionItem = { key: `form:${docType}`, kind: "form", label, action: "sba_forms", urgent: false };
      if (submitted.has(docType)) completed.push(item); else outstanding.push(item);
    };
    add("sba_form_1919", "SBA Form 1919 - Borrower Information");
    const many = input.sbaOwners!.length > 1;
    for (const o of input.sbaOwners!) {
      const docType = o.index === 1 ? "sba_form_413" : "sba_form_413_owner_" + o.index;
      const who = many ? " - " + (String(o.name ?? "").trim() || "Owner " + o.index) : "";
      add(docType, "SBA Form 413 - Personal Financial Statement" + who);
    }
  }

  outstanding.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.label.localeCompare(b.label));
  completed.sort((a, b) => a.label.localeCompare(b.label));
  return { outstanding, completed, outstandingCount: outstanding.length };
}

// BF_SERVER_SBA_FORMS_TODO_v757 - the owners whose forms an SBA deal needs; empty for a non-SBA deal.
export async function sbaOwnersForTodo(applicationId: string): Promise<Array<{ index: number; name: string | null }>> {
  try {
    const { isSbaApplication } = await import("../signnow/sba/sbaTrigger.js");
    if (!(await isSbaApplication(applicationId))) return [];
    const { resolveSbaOwners } = await import("../signnow/sba/sbaOwners.js");
    const owners = await resolveSbaOwners(applicationId);
    return owners.filter((o: any) => o.index >= 1 && o.index <= 5).map((o: any) => ({ index: o.index, name: [o.firstName, o.lastName].filter(Boolean).join(" ") || o.name || null }));
  } catch (err) {
    console.warn("[action-center] sba_owners_read_failed", { applicationId, message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function buildActionCenter(applicationId: string): Promise<ActionCenter> {
  // Every lookup degrades to empty rather than throwing: a half-rendered list is
  // recoverable, an exception on the applicant's home screen is not.
  const docsMod = await import("../routes/clientDocumentsNeeded.js");
  const empty = { stillNeeded: [] as Doc[], rejected: [] as Doc[], required: [] as Doc[] };
  const [docs, requestedForms, waivedAll, formsQ] = await Promise.all([
    docsMod.computeOutstandingDocs(applicationId).catch((err: any) => { console.warn("[action-center] docs_read_failed", { applicationId, message: err?.message }); return empty; }),
    docsMod.getRequestedFormIds(applicationId).catch((err: any) => { console.warn("[action-center] forms_read_failed", { applicationId, message: err?.message }); return [] as string[]; }),
    docsMod.getWaivedDocTypes(applicationId).catch((err: any) => { console.warn("[action-center] waivers_read_failed", { applicationId, message: err?.message }); return new Set<string>(); }),
    dbQuery<{ doc_type: string }>(
      `SELECT doc_type FROM application_form_responses
        WHERE application_id::text = ($1)::text AND submitted_at IS NOT NULL`,
      [applicationId],
    ).catch((err: any) => { console.warn("[action-center] submitted_forms_read_failed", { applicationId, message: err?.message }); return { rows: [] as Array<{ doc_type: string }> }; }),
  ]);
  const waivedForms = Array.from(waivedAll).filter((w) => w.startsWith("form:")).map((w) => w.slice(5));
  const submittedFormTypes = (formsQ.rows ?? []).map((r) => String(r.doc_type ?? ""));
  const sbaOwners = await sbaOwnersForTodo(applicationId); // BF_SERVER_SBA_FORMS_TODO_v757
  const center = assembleActionCenter({
    sbaOwners,
    requestedForms,
    waivedForms,
    submittedFormTypes,
    required: docs.required,
    stillNeeded: docs.stillNeeded,
    rejected: docs.rejected,
  });
  // BF_SERVER_TODO_PROMPTS_v635 - PGI and SBA forms join the to-do list (they used to be chat prompts).
  const prompts = await promptItems(applicationId, submittedFormTypes, sbaOwners.length > 0).catch((err: any) => {
    console.warn("[action-center] prompt_items_failed", { applicationId, message: err?.message });
    return { outstanding: [] as ActionItem[], completed: [] as ActionItem[] };
  });
  const outstanding = [...prompts.outstanding, ...center.outstanding];
  return { outstanding, completed: [...center.completed, ...prompts.completed], outstandingCount: outstanding.length };
}

// BF_SERVER_TODO_PROMPTS_v635
// PGI: only after the client signed a term sheet, and until the PGI application is done.
// SBA forms: once staff asked for them, until the 1919 and a 413 for every 20%+ owner are submitted.
export function sbaFormsMissing(ownerIndexes: number[], submittedFormTypes: string[]): string[] {
  const have = new Set(submittedFormTypes.map((t) => String(t ?? "").trim().toLowerCase()));
  const expected = ["sba_form_1919", ...ownerIndexes.map((i) => (i === 1 ? "sba_form_413" : "sba_form_413_owner_" + i))];
  return expected.filter((t) => !have.has(t));
}

async function promptItems(applicationId: string, submittedFormTypes: string[], sbaListed = false): Promise<{ outstanding: ActionItem[]; completed: ActionItem[] }> {
  const outstanding: ActionItem[] = [];
  const completed: ActionItem[] = [];
  const { PGI_PROMPT_LABEL, termSheetSigned } = await import("./termSheetSigned.js");
  const prompts = await dbQuery<{ cta_label: string | null; cta_action: string | null }>(
    `SELECT cta_label, cta_action FROM communications_messages
      WHERE application_id::text = ($1)::text
        AND (cta_label = $2 OR cta_action IN ('sba_forms', 'form:sba_forms'))
      ORDER BY created_at DESC`,
    [applicationId, PGI_PROMPT_LABEL],
  );
  const rows = prompts.rows ?? [];
  const pgiUrl = rows.find((r) => r.cta_label === PGI_PROMPT_LABEL && /^https?:\/\//i.test(String(r.cta_action ?? "")))?.cta_action ?? null;
  if (pgiUrl && (await termSheetSigned(applicationId))) {
    const { pgiDone, pgiStageFor } = await import("./pgiStage.js");
    const item: ActionItem = { key: "pgi", kind: "action", label: "Complete your Personal Guarantee Insurance application", action: pgiUrl, urgent: true };
    if (pgiDone(await pgiStageFor(applicationId))) completed.push(item); else outstanding.push(item);
  }
  // BF_SERVER_SBA_FORMS_TODO_v757 - skipped when the forms are already listed one by one.
  if (!sbaListed && rows.some((r) => r.cta_action === "sba_forms" || r.cta_action === "form:sba_forms")) {
    const { resolveSbaOwners } = await import("../signnow/sba/sbaOwners.js");
    const owners = await resolveSbaOwners(applicationId);
    const missing = sbaFormsMissing(owners.map((o) => o.index), submittedFormTypes);
    const item: ActionItem = { key: "form:sba_forms", kind: "form", label: "SBA forms", action: "sba_forms", urgent: false };
    if (missing.length) outstanding.push(item); else completed.push(item);
  }
  // BF_SERVER_MEDIA_FEE_AGREEMENT_v709 - the applicant signs the fee agreement here.
  try {
    const fee = await dbQuery<{ status: string; signer_is_applicant: boolean }>(
      `SELECT status, signer_is_applicant FROM media_fee_agreements WHERE application_id = $1 LIMIT 1`,
      [applicationId],
    );
    const row = fee.rows?.[0];
    if (row && row.signer_is_applicant === true && typeof row.status === "string") {
      const item: ActionItem = { key: "fee_agreement", kind: "action", label: "Sign your fee agreement", action: "sign_fee_agreement", urgent: true };
      if (row.status === "signed") completed.push(item); else outstanding.push(item);
    }
  } catch (err: any) {
    console.warn("[action-center] fee_agreement_read_failed", { applicationId, message: err?.message });
  }
  return { outstanding, completed };
}
