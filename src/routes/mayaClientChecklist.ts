// BF_SERVER_v817_MAYA - client Maya's read-only view of the client's OWN application checklist, built exactly
// like the client portal's "What you need to do" panel (GET /api/client/documents-needed/action-center ->
// buildActionCenter, plus the "Sign your application documents" item the portal adds while signing is open)
// and the stage label the portal header shows ("Additional Steps Required" -> "Additional Steps").
// Maya only saw documents, so with every document uploaded she told a client with three forms left that they
// were "all set".
//
// POST /api/maya/client-checklist { application_id, phone }   (service JWT from the Maya agent)
// The application must belong to the verified client phone the agent sends (application_contacts or
// applications.contact_id, same rule as the client portal) - fails closed, so a client only ever sees their own.
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { logError } from "../observability/logger.js";
import { verifyMayaService, audit } from "./mayaStaff.js";
import { applicationOwnershipCounts } from "../auth/clientApplicationOwnership.js";
import type { ActionCenter, ActionItem } from "../services/applicantActions.js";

// BF_SERVER_v817_MAYA - the client portal's stage steps (BF-client components/cmp/cmpData.ts STAGE_STEPS):
// the label the client sees and the line the portal shows under it.
export const CLIENT_STAGE_STEPS = [
  { key: "received", label: "Received", next: "We have your application. Your advisor looks at it next." },
  { key: "in_review", label: "In Review", next: "Your advisor is reviewing your file. If anything is missing, it will appear here." },
  { key: "documents_required", label: "Documents Required", next: "We need a few documents before your file can go to lenders." },
  { key: "additional_steps_required", label: "Additional Steps", next: "Lenders need a few more items before your file moves on. They're listed below." },
  { key: "off_to_lender", label: "Off to Lender", next: "Your file is with lenders. We'll tell you the moment an offer comes in." },
  { key: "offer", label: "Offer", next: "You have an offer. Review it, then accept it or ask for changes." },
] as const;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** BF_SERVER_v817_MAYA - the stage name exactly as the client portal header shows it (shortStageLabel). */
export function clientStageLabel(raw: unknown, notFinished = false): string {
  if (notFinished) return "Not finished";
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/^(accepted|funded)$/i.test(s)) return "Funded";
  const key = s.toLowerCase().replace(/[\s-]+/g, "_");
  const hit = CLIENT_STAGE_STEPS.find((st) => st.key === key);
  return hit ? hit.label : s.replace(/_/g, " ");
}

function stageKey(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export type ClientChecklistApp = {
  pipeline_state: string | null;
  submitted_at: string | null;
  signed_at: string | null;
  finalized_lenders: number;
};

export type ClientChecklistItem = { label: string; type: "document" | "form" | "action"; status: "outstanding" | "done"; needs_reupload?: boolean };

/** BF_SERVER_v817_MAYA - pure: the portal's list, counts and stage text from the action center and the application row. */
export function assembleClientChecklist(app: ClientChecklistApp, center: ActionCenter) {
  // The portal adds "Sign your application documents" while the signing session is open: a lender is
  // finalized and the application is not signed yet (the same rule as deriveSigningStatus ready/started).
  const extras: ActionItem[] = !app.signed_at && app.finalized_lenders > 0
    ? [{ key: "sign", kind: "action", label: "Sign your application documents", urgent: false, action: "sign" }]
    : [];
  const outstanding = [...extras, ...center.outstanding];
  const completed = center.completed;
  const total = outstanding.length + completed.length;
  const item = (i: ActionItem, status: "outstanding" | "done"): ClientChecklistItem => ({
    label: i.label,
    type: i.kind,
    status,
    ...(status === "outstanding" && i.urgent && i.kind === "document" ? { needs_reupload: true } : {}),
  });
  const outDocs = outstanding.filter((i) => i.kind === "document");
  const outForms = outstanding.filter((i) => i.kind !== "document");
  const notFinished = /^draft$/i.test(String(app.pipeline_state ?? "")) || !app.submitted_at;
  const label = clientStageLabel(app.pipeline_state, notFinished);
  const key = stageKey(app.pipeline_state);
  const step = CLIENT_STAGE_STEPS.find((s) => s.key === key);
  // Mirrors the portal's "what happens next" line (BF-client MiniPortalPage statusNext).
  const parts = [
    outDocs.length ? outDocs.length + (outDocs.length === 1 ? " document" : " documents") : "",
    outForms.length ? outForms.length + (outForms.length === 1 ? " form" : " forms") : "",
  ].filter(Boolean).join(" and ");
  const needsItemsStage = key === "documents_required" || key === "additional_steps_required";
  let next: string;
  if (outstanding.length > 0) {
    if (key === "additional_steps_required") next = "Lenders need a few more items before your file moves on: " + parts + ".";
    else if (key === "documents_required") next = "We need a few documents before your file can go to lenders: " + parts + ".";
    else next = outstanding.length + (outstanding.length === 1 ? " thing" : " things") + " left: " + parts + ". Once they're done, your file moves to the next step.";
  } else if (needsItemsStage) {
    next = "Everything asked for so far is in. Your advisor is checking it and will add anything else lenders need.";
  } else {
    next = step?.next ?? "";
  }
  const summary = outstanding.length
    ? `Stage "${label}". ${completed.length} of ${total} done; ${outstanding.length} outstanding (${parts}): ${outstanding.map((i) => i.label).join(", ")}.`
    : `Stage "${label}". Nothing outstanding for the client right now${total ? ` (${completed.length} of ${total} done)` : ""}.`;
  return {
    stage: label,
    stage_raw: app.pipeline_state,
    progress: total ? `${completed.length} of ${total} done` : null,
    done_count: completed.length,
    total_count: total,
    outstanding_count: outstanding.length,
    outstanding_documents: outDocs.length,
    outstanding_forms: outForms.length,
    outstanding: outstanding.map((i) => item(i, "outstanding")),
    completed: completed.map((i) => item(i, "done")),
    what_happens_next: next,
    summary,
  };
}

type Q = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
export type ClientChecklistDeps = {
  query: Q;
  ownership: (applicationId: string, phone10: string) => Promise<{ total: number; mine: number }>;
  buildActionCenter: (applicationId: string) => Promise<ActionCenter>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** BF_SERVER_v817_MAYA - the checklist for one application, only when it belongs to the verified client phone. */
export async function clientChecklist(deps: ClientChecklistDeps, applicationId: string | null, phone: string | null) {
  if (!applicationId || !UUID.test(applicationId)) return { error: "application_id_required", status: 400 };
  const phone10 = String(phone ?? "").replace(/[^0-9]/g, "").slice(-10);
  if (phone10.length < 10) return { error: "verified_phone_required", status: 403 };
  const own = await deps.ownership(applicationId, phone10);
  if (own.total === 0) return { error: "not_found", status: 404 };
  if (own.mine === 0) return { error: "forbidden", status: 403 };
  const r = await deps.query(
    `SELECT a.pipeline_state, a.submitted_at, a.signnow_app_signed_at,
            (SELECT count(*) FROM application_lender_selections s
              WHERE s.application_id::text = a.id::text AND s.finalized_at IS NOT NULL)::int AS finalized_lenders
       FROM applications a WHERE a.id::text = ($1)::text`,
    [applicationId],
  );
  const row = r.rows[0];
  if (!row) return { error: "not_found", status: 404 };
  const center = await deps.buildActionCenter(applicationId);
  return assembleClientChecklist({
    pipeline_state: str(row.pipeline_state),
    submitted_at: row.submitted_at ? String(row.submitted_at) : null,
    signed_at: row.signnow_app_signed_at ? String(row.signnow_app_signed_at) : null,
    finalized_lenders: Number(row.finalized_lenders ?? 0),
  }, center);
}

const router = Router();
router.post("/client-checklist", safeHandler(async (req: Request, res: Response) => {
  if (!verifyMayaService(req)) return res.status(401).json({ ok: false, error: "service_jwt_required" });
  const applicationId = str(req.body?.application_id);
  const sessionId = str(req.body?.session_id);
  try {
    const { buildActionCenter } = await import("../services/applicantActions.js");
    const out: any = await clientChecklist(
      { query: (sql, params) => pool.query(sql, params as any[]) as any, ownership: applicationOwnershipCounts, buildActionCenter },
      applicationId,
      str(req.body?.phone),
    );
    if (out.error) {
      await audit({ audience: "client", tool: "application.checklist", args: { application_id: applicationId }, ok: false, summary: out.error, errorCode: out.error, sessionId });
      return res.status(out.status ?? 400).json({ ok: false, error: out.error });
    }
    await audit({ audience: "client", tool: "application.checklist", args: { application_id: applicationId }, ok: true, summary: out.summary, sessionId });
    return res.json({ ok: true, ...out });
  } catch (e: any) {
    logError("maya_client_checklist_failed", { code: "maya_client_checklist_failed", error: e?.message ?? "unknown" });
    return res.status(500).json({ ok: false, error: "client_checklist_failed" });
  }
}));

export default router;
