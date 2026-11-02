// BF_SERVER_v869_SETTINGS_PACK_PRIVACY - cookie consent records and privacy requests (PIPEDA / Quebec Law 25 style).
//
// Consent: the client app and booking pages record each visitor's choice (granted / denied, by category) before any
// visitor tracking or session replay loads. The IP address is kept only as a salted hash.
//
// Requests: an Admin records an access, correction or deletion request against a contact (30 days to respond).
//   access      export everything held on the contact as JSON
//   correction  fix the contact's details (old and new values audited)
//   deletion    deletes the contact and its activity, unless the 7-year record retention or a legal hold applies
//               (src/retention/). Then the records are kept, the contact is opted out of all marketing and texts,
//               and the outcome says exactly what was kept and why.
// Every step is in the audit log.
import { createHash } from "node:crypto";
import { contactRetention } from "../retention/retention.js";
import type { RetentionStatus } from "../retention/policy.js";
import type { Q } from "../settingsPack/common.js";

export const REQUEST_KINDS = ["access", "correction", "deletion"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const CONSENT_SURFACES = ["client_app", "booking_page", "website"] as const;

export function ipHash(ip: string): string {
  const salt = String(process.env.JWT_SECRET ?? "ks");
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

export type ConsentInput = { visitorId: string; surface: string; choice: "granted" | "denied"; categories: Record<string, boolean>; policyVersion: string | null };

export function parseConsent(raw: unknown): { ok: true; value: ConsentInput } | { ok: false; error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const visitorId = String(r.visitorId ?? r.visitor_id ?? "").trim();
  if (!/^[A-Za-z0-9_.:-]{6,100}$/.test(visitorId)) return { ok: false, error: "invalid_visitor" };
  const surface = String(r.surface ?? "").trim();
  if (!(CONSENT_SURFACES as readonly string[]).includes(surface)) return { ok: false, error: "invalid_surface" };
  const choice = r.choice === "granted" ? "granted" : r.choice === "denied" ? "denied" : null;
  if (!choice) return { ok: false, error: "invalid_choice" };
  const cats = (r.categories && typeof r.categories === "object" ? r.categories : {}) as Record<string, unknown>;
  const categories: Record<string, boolean> = {};
  for (const k of ["analytics", "session_replay", "advertising"]) categories[k] = typeof cats[k] === "boolean" ? (cats[k] as boolean) : choice === "granted";
  const policyVersion = r.policyVersion ? String(r.policyVersion).slice(0, 40) : null;
  return { ok: true, value: { visitorId, surface, choice, categories, policyVersion } };
}

export async function recordConsent(db: Q, c: ConsentInput, meta: { ip: string; userAgent: string }): Promise<void> {
  await db.query(
    `INSERT INTO cookie_consents (visitor_id, surface, choice, categories, policy_version, ip_hash, user_agent) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [c.visitorId, c.surface, c.choice, JSON.stringify(c.categories), c.policyVersion, meta.ip ? ipHash(meta.ip) : null, meta.userAgent.slice(0, 300) || null],
  );
}

// ------------------------------------------------------------------ requests
export type PrivacyRequest = {
  id: string; contact_id: string | null; contact_label: string | null; kind: RequestKind; status: "open" | "completed" | "refused";
  details: string | null; received_via: string | null; requested_at: string; due_at: string; outcome: unknown; completed_at: string | null;
  /** BF_SERVER_v869_SETTINGS_PACK */ silo: string; requester_email: string | null; requester_phone: string | null;
};
const COLS = `id::text AS id, contact_id::text AS contact_id, contact_label, kind, status, details, received_via, requested_at, due_at, outcome, completed_at, silo, requester_email, requester_phone`;

export async function contactLabel(db: Q, contactId: string): Promise<string | null> {
  const r = await db.query(`SELECT COALESCE(NULLIF(name, ''), email, phone, 'Contact') AS label FROM contacts WHERE id::text = $1`, [contactId]);
  return r.rows[0] ? String(r.rows[0].label) : null;
}

// BF_SERVER_v869_SETTINGS_PACK - each silo sees its own requests (BF, BI, SLF).
export async function listRequests(db: Q, silo = "BF"): Promise<PrivacyRequest[]> {
  const r = await db.query(`SELECT ${COLS} FROM privacy_requests WHERE silo = $1 ORDER BY (status = 'open') DESC, due_at ASC, created_at DESC LIMIT 500`, [silo]);
  return r.rows as PrivacyRequest[];
}

export async function contactSilo(db: Q, contactId: string): Promise<string> {
  const r = await db.query(`SELECT silo FROM contacts WHERE id::text = $1`, [contactId]);
  const s = String(r.rows[0]?.silo ?? "BF").toUpperCase();
  return s === "BI" || s === "SLF" ? s : "BF";
}

/** BF_SERVER_v869_SETTINGS_PACK - a client's own request from the client app's privacy page. It is matched to a BF
 *  contact by email when one exists; otherwise staff link the contact before acting on it. */
export async function createPublicRequest(db: Q, input: { name: string; email: string; phone: string | null; kind: RequestKind; details: string | null }): Promise<PrivacyRequest> {
  const match = await db.query(`SELECT id::text AS id FROM contacts WHERE lower(email) = lower($1) AND COALESCE(silo, 'BF') = 'BF' ORDER BY created_at ASC LIMIT 1`, [input.email]);
  const contactId = match.rows[0]?.id ? String(match.rows[0].id) : null;
  const r = await db.query(
    `INSERT INTO privacy_requests (contact_id, contact_label, kind, details, received_via, silo, requester_email, requester_phone)
     VALUES ($1::uuid, $2, $3, $4, 'client_app', 'BF', $5, $6)
     RETURNING ${COLS}`,
    [contactId, `${input.name} <${input.email}>`, input.kind, input.details, input.email, input.phone],
  );
  return r.rows[0] as PrivacyRequest;
}

export async function linkRequestContact(db: Q, id: string, contactId: string, label: string): Promise<PrivacyRequest | null> {
  const r = await db.query(
    `UPDATE privacy_requests SET contact_id = $2::uuid, contact_label = $3, updated_at = now() WHERE id::text = $1 AND status = 'open' RETURNING ${COLS}`,
    [id, contactId, label]);
  return (r.rows[0] as PrivacyRequest) ?? null;
}

export async function getRequest(db: Q, id: string): Promise<PrivacyRequest | null> {
  const r = await db.query(`SELECT ${COLS} FROM privacy_requests WHERE id::text = $1`, [id]);
  return (r.rows[0] as PrivacyRequest) ?? null;
}

export async function createRequest(db: Q, input: { contactId: string; label: string; kind: RequestKind; details: string | null; receivedVia: string | null; requestedAt: Date | null; actor: string | null; silo?: string }): Promise<PrivacyRequest> {
  const r = await db.query(
    `INSERT INTO privacy_requests (contact_id, contact_label, kind, details, received_via, requested_at, due_at, created_by, silo)
     VALUES ($1::uuid, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), COALESCE($6::timestamptz, now()) + interval '30 days', $7::uuid, $8)
     RETURNING ${COLS}`,
    [input.contactId, input.label, input.kind, input.details, input.receivedVia, input.requestedAt ? input.requestedAt.toISOString() : null, input.actor, input.silo ?? "BF"],
  );
  return r.rows[0] as PrivacyRequest;
}

export async function closeRequest(db: Q, id: string, status: "completed" | "refused", outcome: unknown, actor: string | null): Promise<PrivacyRequest | null> {
  const r = await db.query(
    `UPDATE privacy_requests SET status = $2, outcome = $3::jsonb, completed_at = now(), completed_by = $4::uuid, updated_at = now()
      WHERE id::text = $1 AND status = 'open' RETURNING ${COLS}`,
    [id, status, JSON.stringify(outcome ?? {}), actor],
  );
  return (r.rows[0] as PrivacyRequest) ?? null;
}

// ------------------------------------------------------------------ access: the export
/** Everything held about a person, by table. Tables with a contact_id column (migrations/000000_baseline.sql). */
export const EXPORT_TABLES = [
  "crm_notes", "crm_call_log", "crm_email_log", "crm_meetings", "tasks", "crm_timeline_events", "communications_messages",
  "voicemails", "call_logs", "contact_documents", "client_bookings", "visitor_sessions", "contact_ad_attribution", "sequence_sends",
  "sms_campaign_sends", "email_link_clicks", "marketing_sequence_enrollments", "booking_events", "applications",
] as const;
const HIDDEN_COLUMNS = new Set(["manage_token_hash", "secret_hash", "token", "token_hash", "o365_refresh_token", "ssn_encrypted", "sin_encrypted"]);

function scrub(rows: any[]): any[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k, v]) => !HIDDEN_COLUMNS.has(k) && !(v instanceof Buffer))));
}

export async function exportContact(db: Q, contactId: string): Promise<{ contact: unknown; records: Record<string, unknown[]>; skipped: Record<string, string>; generated_at: string }> {
  const c = await db.query(`SELECT * FROM contacts WHERE id::text = $1`, [contactId]);
  const records: Record<string, unknown[]> = {};
  const skipped: Record<string, string> = {};
  for (const table of EXPORT_TABLES) {
    try {
      const r = await db.query(`SELECT * FROM ${table} WHERE contact_id::text = $1 LIMIT 5000`, [contactId]);
      if (r.rows.length) records[table] = scrub(r.rows);
    } catch (err) {
      // A table this copy does not have (or a column it lacks) must not stop the export; it is listed, and logged.
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[privacy] export table skipped", { table, message });
      skipped[table] = message.slice(0, 200);
    }
  }
  return { contact: scrub(c.rows)[0] ?? null, records, skipped, generated_at: new Date().toISOString() };
}

// ------------------------------------------------------------------ correction
export const CORRECTABLE = ["name", "email", "phone", "secondary_email", "secondary_phone"] as const;

export function parseCorrection(raw: unknown): { ok: true; value: Partial<Record<(typeof CORRECTABLE)[number], string>> } | { ok: false; errors: Record<string, string> } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const value: Partial<Record<(typeof CORRECTABLE)[number], string>> = {};
  const errors: Record<string, string> = {};
  for (const f of CORRECTABLE) {
    if (r[f] === undefined) continue;
    const v = String(r[f] ?? "").trim();
    if (v.length > 200) { errors[f] = "Too long (200 characters at most)."; continue; }
    if ((f === "email" || f === "secondary_email") && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { errors[f] = "Not an email address."; continue; }
    if ((f === "phone" || f === "secondary_phone") && v && v.replace(/\D/g, "").length < 10) { errors[f] = "Not a phone number."; continue; }
    if (f === "name" && !v) { errors[f] = "A name is needed."; continue; }
    value[f] = v;
  }
  if (!Object.keys(value).length && !Object.keys(errors).length) errors._ = "Nothing to correct.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

export async function correctContact(db: Q, contactId: string, changes: Record<string, string>): Promise<Array<{ field: string; from: unknown; to: string }>> {
  const fields = Object.keys(changes).filter((f) => (CORRECTABLE as readonly string[]).includes(f));
  const before = await db.query(`SELECT ${fields.join(", ")} FROM contacts WHERE id::text = $1`, [contactId]);
  const row = before.rows[0] ?? {};
  const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
  await db.query(`UPDATE contacts SET ${sets}, updated_at = now() WHERE id::text = $1`, [contactId, ...fields.map((f) => changes[f] || null)]);
  return fields.map((f) => ({ field: f, from: row[f] ?? null, to: changes[f]! }));
}

// ------------------------------------------------------------------ deletion
/** Activity removed with the contact when no retention or hold applies (contacts itself last). */
export const DELETE_TABLES = [
  "crm_notes", "crm_call_log", "crm_email_log", "crm_meetings", "tasks", "crm_timeline_events", "communications_messages",
  "voicemails", "client_bookings", "visitor_sessions", "contact_ad_attribution", "sequence_sends", "sms_campaign_sends", "email_link_clicks",
  "marketing_sequence_enrollments", "booking_events",
] as const;

export type DeletionPlan = { contact_id: string; can_delete: boolean; retention: RetentionStatus; will_delete: string[]; will_keep: Array<{ what: string; why: string; until: string | null }> };

export function explainKept(s: RetentionStatus): Array<{ what: string; why: string; until: string | null }> {
  if (!s.locked) return [];
  if (s.reason === "hold") {
    return s.holds.map((h) => ({ what: `Everything on ${h.target_label ?? `${h.target_type} ${h.target_id}`}`, why: `Legal hold placed ${h.placed_at ? h.placed_at.slice(0, 10) : ""}: ${h.reason}`.trim(), until: null }));
  }
  return [{
    what: "The contact, its applications, documents and signed agreements",
    why: s.message ?? (s.file_open ? "An application is still open; records are kept for 7 years after it closes." : "Records are kept for 7 years from the later of upload and the file closing."),
    until: s.deletable_on,
  }];
}

export async function planDeletion(db: Q, contactId: string): Promise<DeletionPlan> {
  const retention = await contactRetention(contactId, db as any);
  return {
    contact_id: contactId,
    can_delete: !retention.locked,
    retention,
    will_delete: retention.locked ? [] : ["The contact", ...DELETE_TABLES.map((t) => t.replace(/_/g, " "))],
    will_keep: explainKept(retention),
  };
}

export type DeletionOutcome = {
  deleted: boolean;
  removed: Record<string, number>;
  kept: Array<{ what: string; why: string; until: string | null }>;
  suppressed: string[];
};

type Tx = Q & { release?: () => void };

/**
 * Carries out a deletion request. With no retention or hold: the contact and its activity, in one transaction.
 * Otherwise: nothing is deleted; the contact is opted out of marketing email and texts (consent withdrawn) so it is
 * only contacted about its open file, and the outcome lists what was kept and until when.
 */
export async function carryOutDeletion(connect: () => Promise<Tx>, db: Q, contactId: string): Promise<DeletionOutcome> {
  const plan = await planDeletion(db, contactId);
  if (!plan.can_delete) {
    await db.query(
      `UPDATE contacts SET marketing_opt_out = true, sms_opt_out = true, sms_consent = false, updated_at = now() WHERE id::text = $1`, [contactId]);
    return { deleted: false, removed: {}, kept: plan.will_keep, suppressed: ["marketing email", "text messages"] };
  }
  const client = await connect();
  const removed: Record<string, number> = {};
  try {
    await client.query("BEGIN");
    for (const table of DELETE_TABLES) {
      await client.query(`SAVEPOINT sp_${table}`);
      try {
        const r = await client.query(`DELETE FROM ${table} WHERE contact_id::text = $1`, [contactId]);
        if (r.rowCount) removed[table] = Number(r.rowCount);
        await client.query(`RELEASE SAVEPOINT sp_${table}`);
      } catch (err) {
        // Only a missing table/column is tolerated (logged); anything else aborts the whole deletion.
        const code = (err as { code?: string })?.code;
        await client.query(`ROLLBACK TO SAVEPOINT sp_${table}`);
        if (code !== "42P01" && code !== "42703") throw err;
        console.warn("[privacy] deletion skipped a table this copy does not have", { table, code });
      }
    }
    const c = await client.query(`DELETE FROM contacts WHERE id::text = $1`, [contactId]);
    removed.contacts = Number(c.rowCount ?? 0);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch((e: unknown) => console.error("[privacy] rollback failed", e instanceof Error ? e.message : e));
    throw err;
  } finally {
    client.release?.();
  }
  return { deleted: true, removed, kept: [], suppressed: [] };
}
