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
  kind: "document" | "form";
  label: string;
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
  for (const task of FORM_TASKS) {
    if (!requested.has(task.key) || waived.has(task.key)) continue;
    const done = input.submittedFormTypes.some((t) => task.match.test(t));
    const item: ActionItem = { key: `form:${task.key}`, kind: "form", label: task.label, urgent: false };
    if (done) completed.push(item);
    else outstanding.push(item);
  }

  outstanding.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.label.localeCompare(b.label));
  completed.sort((a, b) => a.label.localeCompare(b.label));
  return { outstanding, completed, outstandingCount: outstanding.length };
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
  return assembleActionCenter({
    requestedForms,
    waivedForms,
    submittedFormTypes: (formsQ.rows ?? []).map((r) => String(r.doc_type ?? "")),
    required: docs.required,
    stillNeeded: docs.stillNeeded,
    rejected: docs.rejected,
  });
}
