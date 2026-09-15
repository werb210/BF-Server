// BF_SERVER_APPLICANT_ACTION_CENTER_v197
// One answer to "what does this applicant still have to do".
//
// Before this there were two: the v778 block in routes/client/index.ts derived a
// completed-task set to filter the message thread, and clientDocumentsNeeded.ts
// derived a still-needed document list from document_requirements. They used
// different sources and different matching, so the chat thread and the document
// picker could disagree about whether the same task was done. Anything new that
// asked the question a third way would make that worse, so both callers are meant
// to converge here.
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

// The task keys the client wizard and mini-portal already use. Kept identical to
// v778's vocabulary so the thread filter can adopt this without changing the CTAs
// that are already stored on live messages.
const FORM_TASKS: Array<{ key: string; label: string; match: RegExp }> = [
  { key: "cra", label: "CRA Authorization", match: /cra/i },
  { key: "networth", label: "Personal Net Worth", match: /net.?worth/i },
  { key: "advisors", label: "Professional Advisors", match: /advisor/i },
  { key: "debt", label: "Debt Stack", match: /debt/i },
  { key: "equipment", label: "Equipment Details", match: /equipment/i },
  { key: "realestate", label: "Real Estate Schedule", match: /real.?estate/i },
  { key: "flinks", label: "Connect Bank (View-Only)", match: /flinks|bank/i },
];

function prettyCategory(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "Document";
  return s
    .replace(/_/g, " ")
    .replace(/\b6 months\b/i, "(6 months)")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function buildActionCenter(applicationId: string): Promise<ActionCenter> {
  // Every lookup degrades to empty rather than throwing. A half-rendered action
  // list is recoverable; an exception on the applicant's home screen is not.
  const [formsQ, docsQ, reqQ, rejectedQ] = await Promise.all([
    dbQuery<{ doc_type: string }>(
      `SELECT doc_type FROM application_form_responses
        WHERE application_id::text = ($1)::text AND submitted_at IS NOT NULL`,
      [applicationId],
    ).catch(() => ({ rows: [] as Array<{ doc_type: string }> })),
    dbQuery<{ category: string }>(
      `SELECT DISTINCT lower(coalesce(category,'')) AS category FROM documents
        WHERE application_id::text = ($1)::text
          AND coalesce(status,'') <> 'rejected'
          AND deleted_at IS NULL`,
      [applicationId],
    ).catch(() => ({ rows: [] as Array<{ category: string }> })),
    dbQuery<{ category: string }>(
      `SELECT lower(coalesce(category,'')) AS category FROM document_requirements
        WHERE application_id::text = ($1)::text AND required = true AND category IS NOT NULL`,
      [applicationId],
    ).catch(() => ({ rows: [] as Array<{ category: string }> })),
    dbQuery<{ category: string }>(
      `SELECT DISTINCT lower(coalesce(category,'')) AS category FROM documents
        WHERE application_id::text = ($1)::text AND coalesce(status,'') = 'rejected'
          AND deleted_at IS NULL`,
      [applicationId],
    ).catch(() => ({ rows: [] as Array<{ category: string }> })),
  ]);

  const submittedForms = (formsQ.rows ?? []).map((r) => String(r.doc_type ?? ""));
  const uploaded = new Set((docsQ.rows ?? []).map((r) => String(r.category ?? "")).filter(Boolean));
  const required = (reqQ.rows ?? []).map((r) => String(r.category ?? "")).filter(Boolean);
  const rejected = new Set((rejectedQ.rows ?? []).map((r) => String(r.category ?? "")).filter(Boolean));

  const outstanding: ActionItem[] = [];
  const completed: ActionItem[] = [];

  // Documents. Both upload lookups apply deleted_at IS NULL so neither the
  // completed nor rejected counts can be affected by soft-deleted records.
  // A rejected category counts as outstanding even if an older
  // accepted upload exists for it - staff rejected the latest one for a reason.
  for (const category of Array.from(new Set(required))) {
    const item: ActionItem = {
      key: `upload:${category}`,
      kind: "document",
      label: prettyCategory(category),
      urgent: rejected.has(category),
    };
    if (rejected.has(category) || !uploaded.has(category)) outstanding.push(item);
    else completed.push(item);
  }

  // A rejected document whose category is no longer in the requirements list
  // still needs re-uploading, or the applicant is never told about it.
  for (const category of rejected) {
    if (required.includes(category)) continue;
    outstanding.push({
      key: `upload:${category}`,
      kind: "document",
      label: prettyCategory(category),
      urgent: true,
    });
  }

  // Forms. Only forms actually asked of this application appear; a form is asked
  // for if a response row exists for it at all, submitted or not.
  const askedQ = await dbQuery<{ doc_type: string }>(
    `SELECT DISTINCT doc_type FROM application_form_responses
      WHERE application_id::text = ($1)::text`,
    [applicationId],
  ).catch(() => ({ rows: [] as Array<{ doc_type: string }> }));
  const asked = (askedQ.rows ?? []).map((r) => String(r.doc_type ?? ""));

  for (const task of FORM_TASKS) {
    if (!asked.some((d) => task.match.test(d))) continue;
    const done = submittedForms.some((d) => task.match.test(d));
    const item: ActionItem = { key: `form:${task.key}`, kind: "form", label: task.label, urgent: false };
    if (done) completed.push(item);
    else outstanding.push(item);
  }

  outstanding.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.label.localeCompare(b.label));
  completed.sort((a, b) => a.label.localeCompare(b.label));

  return { outstanding, completed, outstandingCount: outstanding.length };
}
