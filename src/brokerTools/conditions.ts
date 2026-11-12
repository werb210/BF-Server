// BF_SERVER_v865_BROKER_TOOLS_1_FUNDING_CONDITIONS - the funding conditions checklist between Accepted and Funded.
//
// Each application gets a list of conditions: from the lender's accepted offer (one per line of its notes), from the
// templates set up for the lender / lender product (blank = every deal), or added by hand. Each has an owner (staff,
// client or lender), an optional person and due date, a status (open, received, cleared, waived) and an optional
// document. A file moves to Funded only when every condition is cleared or waived. An Admin may override with a
// reason; the override is written to the audit log. Clients see the open conditions they own in the client app.
import type { Q } from "./common.js";
import { isoDate, str, oneOf } from "./common.js";

export const OWNERS = ["staff", "client", "lender"] as const;
export type Owner = (typeof OWNERS)[number];
export const STATUSES = ["open", "received", "cleared", "waived"] as const;
export type ConditionStatus = (typeof STATUSES)[number];

/** Statuses that let the file fund. */
export const DONE: readonly ConditionStatus[] = ["cleared", "waived"];

export type Condition = {
  id: string;
  application_id: string;
  title: string;
  description: string | null;
  owner: Owner;
  assigned_user_id: string | null;
  assigned_name?: string | null;
  due_date: string | null;
  status: ConditionStatus;
  source: string;
  offer_id: string | null;
  requires_document: boolean;
  document_id: string | null;
  document_url: string | null;
  note: string | null;
  waived_reason: string | null;
  cleared_at: string | null;
  waived_at: string | null;
  client_submitted_at: string | null;
  overdue: boolean;
};

const dateText = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return isoDate(v);
};

export function rowToCondition(r: Record<string, any>, today = new Date()): Condition {
  const due = dateText(r.due_date);
  const status = oneOf(r.status, STATUSES, "open");
  return {
    id: String(r.id),
    application_id: String(r.application_id),
    title: String(r.title ?? ""),
    description: r.description ?? null,
    owner: oneOf(r.owner, OWNERS, "staff"),
    assigned_user_id: r.assigned_user_id ? String(r.assigned_user_id) : null,
    assigned_name: r.assigned_name ?? null,
    due_date: due,
    status,
    source: String(r.source ?? "manual"),
    offer_id: r.offer_id ? String(r.offer_id) : null,
    requires_document: r.requires_document === true,
    document_id: r.document_id ? String(r.document_id) : null,
    document_url: r.document_url ?? null,
    note: r.note ?? null,
    waived_reason: r.waived_reason ?? null,
    cleared_at: r.cleared_at ? new Date(r.cleared_at).toISOString() : null,
    waived_at: r.waived_at ? new Date(r.waived_at).toISOString() : null,
    client_submitted_at: r.client_submitted_at ? new Date(r.client_submitted_at).toISOString() : null,
    overdue: Boolean(due && !DONE.includes(status) && due < today.toISOString().slice(0, 10)),
  };
}

/** The conditions still blocking funding. */
export function outstanding(list: Condition[]): Condition[] {
  return list.filter((c) => !DONE.includes(c.status));
}

/** Lines of a lender's offer notes that read as conditions ("- Void cheque", "1. Insurance certificate", ...). */
export function conditionsFromOfferText(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of String(text ?? "").split(/\r?\n|;/)) {
    const line = raw.replace(/^\s*(?:[-*\u2022]|\d+[.)]|\(?[a-z]\))\s*/i, "").replace(/^conditions?\s*[:-]\s*/i, "").trim();
    if (line.length < 3 || line.length > 300) continue;
    if (/^(conditions?|subject to)\s*:?$/i.test(line)) continue;
    if (!out.some((x) => x.toLowerCase() === line.toLowerCase())) out.push(line);
  }
  return out.slice(0, 40);
}

export type ConditionInput = {
  title: string; description: string | null; owner: Owner; assigned_user_id: string | null; due_date: string | null;
  requires_document: boolean; document_url: string | null; note: string | null;
};

export function parseConditionInput(b: Record<string, unknown>, partial = false):
  { ok: true; value: Partial<ConditionInput> } | { ok: false; error: string } {
  const v: Partial<ConditionInput> = {};
  if (!partial || b.title !== undefined) {
    const t = str(b.title, 300);
    if (!t) return { ok: false, error: "Give the condition a title." };
    v.title = t;
  }
  if (b.description !== undefined) v.description = str(b.description, 4000);
  if (!partial || b.owner !== undefined) v.owner = oneOf(b.owner, OWNERS, "staff");
  if (b.assigned_user_id !== undefined) {
    const u = str(b.assigned_user_id, 80);
    if (u && !/^[0-9a-f-]{36}$/i.test(u)) return { ok: false, error: "Pick a person from the list." };
    v.assigned_user_id = u;
  }
  if (b.due_date !== undefined) {
    const raw = str(b.due_date, 40);
    const d = isoDate(raw);
    if (raw && !d) return { ok: false, error: "Use a date like 2026-11-30." };
    v.due_date = d;
  }
  if (b.requires_document !== undefined) v.requires_document = b.requires_document === true;
  if (b.document_url !== undefined) {
    const u = str(b.document_url, 2000);
    if (u && !/^https?:\/\//i.test(u)) return { ok: false, error: "The document link must start with https://" };
    v.document_url = u;
  }
  if (b.note !== undefined) v.note = str(b.note, 4000);
  return { ok: true, value: v };
}

const SELECT = `SELECT fc.*, NULLIF(trim(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS assigned_name
  FROM funding_conditions fc LEFT JOIN users u ON u.id = fc.assigned_user_id`;

export async function listConditions(q: Q, applicationId: string): Promise<Condition[]> {
  const r = await q.query(`${SELECT} WHERE fc.application_id = $1 ORDER BY fc.position, fc.created_at`, [applicationId]);
  return r.rows.map((row) => rowToCondition(row));
}

export async function getCondition(q: Q, applicationId: string, id: string): Promise<Condition | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await q.query(`${SELECT} WHERE fc.application_id = $1 AND fc.id = $2::uuid`, [applicationId, id]);
  return r.rows[0] ? rowToCondition(r.rows[0]) : null;
}

export async function addCondition(q: Q, applicationId: string, v: ConditionInput & { source?: string; template_id?: string | null; offer_id?: string | null },
  actor: string | null): Promise<Condition> {
  const r = await q.query(
    `INSERT INTO funding_conditions (application_id, title, description, owner, assigned_user_id, due_date, requires_document,
        document_url, note, source, template_id, offer_id, position, created_by)
     VALUES ($1, $2, $3, $4, $5::uuid, $6::date, $7, $8, $9, $10, $11::uuid, $12,
        (SELECT COALESCE(max(position), 0) + 1 FROM funding_conditions WHERE application_id = $1), $13::uuid)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [applicationId, v.title, v.description, v.owner, v.assigned_user_id, v.due_date, v.requires_document, v.document_url, v.note,
      v.source ?? "manual", v.template_id ?? null, v.offer_id ?? null, actor],
  );
  const id = r.rows[0]?.id;
  if (!id) {
    const again = await q.query(`${SELECT} WHERE fc.application_id = $1 AND fc.template_id = $2::uuid`, [applicationId, v.template_id]);
    return rowToCondition(again.rows[0]);
  }
  return (await getCondition(q, applicationId, String(id)))!;
}

/** Templates for the application's lender / product (and the ones for every deal), not yet on the file. */
export async function applyTemplates(q: Q, app: { id: string; lender_id: string | null; lender_product_id: string | null }, actor: string | null): Promise<number> {
  const t = await q.query(
    `SELECT * FROM funding_condition_templates
      WHERE active = true
        AND (lender_id IS NULL OR lender_id::text = $1)
        AND (lender_product_id IS NULL OR lender_product_id = $2)
        AND NOT EXISTS (SELECT 1 FROM funding_conditions fc WHERE fc.application_id = $3 AND fc.template_id = funding_condition_templates.id)
      ORDER BY position, created_at`,
    [app.lender_id ?? "", app.lender_product_id ?? "", app.id],
  );
  let added = 0;
  for (const tpl of t.rows) {
    const due = typeof tpl.due_days === "number" && tpl.due_days >= 0
      ? new Date(Date.now() + tpl.due_days * 86_400_000).toISOString().slice(0, 10) : null;
    await addCondition(q, app.id, {
      title: tpl.title, description: tpl.description ?? null, owner: oneOf(tpl.owner, OWNERS, "staff"), assigned_user_id: null,
      due_date: due, requires_document: tpl.requires_document === true, document_url: null, note: null,
      source: "template", template_id: String(tpl.id),
    }, actor);
    added += 1;
  }
  return added;
}

/** One condition per line of the accepted (or newest) offer's notes, skipping titles already on the file. */
export async function importFromOffer(q: Q, applicationId: string, actor: string | null): Promise<{ added: number; offer_id: string | null }> {
  const o = await q.query(
    `SELECT id::text AS id, notes FROM offers WHERE application_id = $1 AND COALESCE(is_archived, false) = false
      ORDER BY (status = 'accepted') DESC, updated_at DESC NULLS LAST LIMIT 1`,
    [applicationId],
  );
  const offer = o.rows[0];
  if (!offer) return { added: 0, offer_id: null };
  const existing = new Set((await listConditions(q, applicationId)).map((c) => c.title.toLowerCase()));
  let added = 0;
  for (const title of conditionsFromOfferText(offer.notes)) {
    if (existing.has(title.toLowerCase())) continue;
    await addCondition(q, applicationId, {
      title, description: null, owner: "staff", assigned_user_id: null, due_date: null, requires_document: false,
      document_url: null, note: null, source: "offer", offer_id: offer.id,
    }, actor);
    existing.add(title.toLowerCase());
    added += 1;
  }
  return { added, offer_id: offer.id };
}

export class FundingBlockedError extends Error {
  constructor(public readonly outstanding: Condition[]) {
    super(`${outstanding.length} funding condition${outstanding.length === 1 ? " is" : "s are"} still open.`);
    this.name = "FundingBlockedError";
  }
}

/**
 * The Funded gate. Throws FundingBlockedError while a condition is open or received, unless an Admin gives an
 * override reason (3+ characters). Returns what happened so the caller can write it to the audit log.
 */
export async function checkFundingGate(q: Q, applicationId: string, opts: { isAdmin: boolean; overrideReason?: string | null }):
  Promise<{ outstanding: number; overridden: boolean }> {
  const open = outstanding(forSignedOffer(await listConditions(q, applicationId), await signedOfferId(q, applicationId)));
  if (open.length === 0) return { outstanding: 0, overridden: false };
  const reason = String(opts.overrideReason ?? "").trim();
  if (opts.isAdmin && reason.length >= 3) return { outstanding: open.length, overridden: true };
  throw new FundingBlockedError(open);
}

// BF_SERVER_v947_CONDITIONS_PER_SHEET (Todd, Nov 12 2026). Each condition read from a term sheet belongs to that term
// sheet (offer_id). Once the client has signed one, only that sheet's conditions (and the ones added by hand or from
// templates, which have no offer_id) count - for the client's list, the staff checklist's count and the Funded gate.

/** The offer the client signed: the accepted one, else the one whose SignNow copy came back signed. Null until then. */
export async function signedOfferId(q: Q, applicationId: string): Promise<string | null> {
  const r = await q.query(
    `SELECT o.id::text AS id
       FROM offers o
       LEFT JOIN applications a ON a.id::text = o.application_id::text
      WHERE o.application_id::text = $1 AND COALESCE(o.is_archived, false) = false
        AND (o.status = 'accepted'
          OR (a.metadata->'offer_signnow'->>'offer_id' = o.id::text AND EXISTS (
                SELECT 1 FROM documents d JOIN document_versions v ON v.document_id = d.id
                 WHERE d.application_id::text = o.application_id::text AND d.document_type = 'signed_term_sheet'
                   AND d.uploaded_by = 'system' AND v.metadata->>'docId' = a.metadata->'offer_signnow'->>'doc_id')))
      ORDER BY (o.status = 'accepted') DESC, o.updated_at DESC NULLS LAST LIMIT 1`,
    [applicationId],
  );
  return r.rows[0]?.id ? String(r.rows[0].id) : null;
}

/** The conditions that count on this file: all of them until a sheet is signed, then the signed sheet's and the unlinked ones. */
export function forSignedOffer(list: Condition[], signed: string | null): Condition[] {
  return signed ? list.filter((c) => !c.offer_id || c.offer_id === signed) : list;
}

const ONGOING = /\b(weekly|monthly|quarterly|annual(ly)?|regular(ly)?|ongoing|at all times|from time to time|until repayment|during the term)\b|\bmaintain\b|\bcovenant|\bno material adverse change\b|\bstatus reports?\b/i;
/** An obligation that runs after funding (reporting, keeping insurance in force, ratios): never a to-do before funding. */
export function isOngoing(c: { title: string; description?: string | null }): boolean {
  return ONGOING.test(c.title) || ONGOING.test(String(c.description ?? "").slice(0, 200));
}

/**
 * What the client sees: nothing until they have signed a term sheet; then the open conditions they own on that sheet
 * (and unlinked ones), without ongoing obligations and without staff notes.
 */
export function clientView(list: Condition[], signed: string | null) {
  if (!signed) return [];
  return forSignedOffer(list, signed)
    .filter((c) => c.owner === "client" && !DONE.includes(c.status) && !isOngoing(c))
    .map((c) => ({ id: c.id, title: c.title, description: c.description, due_date: c.due_date, status: c.status,
      requires_document: c.requires_document, submitted: Boolean(c.client_submitted_at) }));
}
