// BF_SERVER_v850_KS_CRM - the Keystone (KS) CRM: the KS-Ops ingest (POST /api/ks/crm/upsert) and the Keystone
// sales pipeline (stage per contact / company).
//
// Everything here is silo 'KS'. Contacts are matched within KS by the KS-Ops reference first (source + external_id,
// so a changed email still hits the same record), then email (case-insensitive), then phone (last 10 digits);
// companies by the reference, then company_code, then name. Automatic stage updates only move forward
// (lead < demo_started < demo_finished < signed_up < paying) and never touch a record staff marked lost; staff can set
// any stage by hand. Notes and events are written to the CRM timeline (crm_notes, silo KS) once each.
import { createHash } from "node:crypto";
import { createContact } from "../../services/contacts.js";

export type Q = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const KS_SILO = "KS";
export const KS_STAGES = ["lead", "demo_started", "demo_finished", "signed_up", "paying", "lost"] as const;
export type KsStage = (typeof KS_STAGES)[number];
export const KS_STAGE_LABELS: Record<KsStage, string> = {
  lead: "Lead",
  demo_started: "Demo started",
  demo_finished: "Demo finished",
  signed_up: "Signed up",
  paying: "Paying",
  lost: "Lost",
};
export const KS_SOURCES = ["demo_signup", "website_signup", "licensee"] as const;
export type KsSource = (typeof KS_SOURCES)[number];
export const KS_EVENT_TYPES = ["demo_opened", "demo_step", "demo_completed", "signup", "payment", "status_change"] as const;
export type KsEventType = (typeof KS_EVENT_TYPES)[number];
const SOURCE_LABELS: Record<KsSource, string> = { demo_signup: "demo sign-up", website_signup: "website sign-up", licensee: "licensee" };

const RANK: Record<string, number> = { lead: 0, demo_started: 1, demo_finished: 2, signed_up: 3, paying: 4 };

export function isKsStage(v: unknown): v is KsStage {
  return typeof v === "string" && (KS_STAGES as readonly string[]).includes(v);
}

/**
 * The stage after an automatic (KS-Ops) update. Forward only; `lost` is staff-only, so an automatic update never sets
 * it and never moves a record out of it. A record with no stage yet starts at `lead`.
 */
export function nextAutoStage(current: string | null | undefined, incoming: string | null | undefined): KsStage {
  const cur = isKsStage(current) ? current : null;
  if (cur === "lost") return "lost";
  const base: KsStage = cur ?? "lead";
  if (!isKsStage(incoming) || incoming === "lost") return base;
  return RANK[incoming]! > RANK[base]! ? incoming : base;
}

export type KsContactInput = { name: string | null; email: string | null; phone: string | null; title: string | null };
export type KsCompanyInput = {
  name: string | null;
  website: string | null;
  company_code: string | null;
  plan: string | null;
  seats: number | null;
  status: string | null;
};
export type KsEventInput = { type: KsEventType; at: string; summary: string | null };
export type KsUpsertInput = {
  source: KsSource;
  external_id: string;
  stage: KsStage | null;
  contact: KsContactInput | null;
  company: KsCompanyInput | null;
  note: string | null;
  events: KsEventInput[];
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function optText(errors: Record<string, string>, key: string, v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    errors[key] = "must be text";
    return null;
  }
  const t = v.trim();
  if (t.length > max) {
    errors[key] = `must be ${max} characters or fewer`;
    return null;
  }
  return t || null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Validates the KS-Ops body. Returns the clean input, or the field errors (400 validation_error). */
export function parseKsUpsert(body: unknown): { ok: true; value: KsUpsertInput } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const b = isPlainObject(body) ? body : {};
  if (!isPlainObject(body)) errors.body = "must be a JSON object";

  const source = b.source;
  if (typeof source !== "string" || !(KS_SOURCES as readonly string[]).includes(source)) {
    errors.source = "must be demo_signup, website_signup or licensee";
  }
  let externalId = "";
  if (typeof b.external_id === "string") externalId = b.external_id.trim();
  else if (typeof b.external_id === "number" && Number.isFinite(b.external_id)) externalId = String(b.external_id);
  if (!externalId) errors.external_id = "is required";
  else if (externalId.length > 100) errors.external_id = "must be 100 characters or fewer";

  let stage: KsStage | null = null;
  if (b.stage !== undefined && b.stage !== null) {
    if (isKsStage(b.stage)) stage = b.stage;
    else errors.stage = "must be one of " + KS_STAGES.join(", ");
  }

  let contact: KsContactInput | null = null;
  if (b.contact !== undefined && b.contact !== null) {
    if (!isPlainObject(b.contact)) errors.contact = "must be an object";
    else {
      const c = b.contact;
      const name = optText(errors, "contact.name", c.name, 200);
      const email = optText(errors, "contact.email", c.email, 254);
      if (email && !EMAIL_RE.test(email)) errors["contact.email"] = "is not a valid email";
      const phone = optText(errors, "contact.phone", c.phone, 40);
      if (phone && phone.replace(/\D/g, "").length < 7) errors["contact.phone"] = "is not a valid phone number";
      const title = optText(errors, "contact.title", c.title, 200);
      if (!name && !email && !phone && !errors["contact.name"] && !errors["contact.email"] && !errors["contact.phone"]) {
        errors.contact = "needs a name, email or phone";
      }
      contact = { name, email: email ? email.toLowerCase() : null, phone, title };
    }
  }

  let company: KsCompanyInput | null = null;
  if (b.company !== undefined && b.company !== null) {
    if (!isPlainObject(b.company)) errors.company = "must be an object";
    else {
      const c = b.company;
      const name = optText(errors, "company.name", c.name, 200);
      const website = optText(errors, "company.website", c.website, 500);
      const code = optText(errors, "company.company_code", c.company_code, 100);
      const plan = optText(errors, "company.plan", c.plan, 100);
      const status = optText(errors, "company.status", c.status, 50);
      let seats: number | null = null;
      if (c.seats !== undefined && c.seats !== null) {
        const n = typeof c.seats === "string" && c.seats.trim() ? Number(c.seats) : c.seats;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 1_000_000) errors["company.seats"] = "must be a whole number";
        else seats = n;
      }
      if (!name && !code && !errors["company.name"] && !errors["company.company_code"]) {
        errors.company = "needs a name or company_code";
      }
      company = { name, website, company_code: code, plan, seats, status };
    }
  }

  const note = optText(errors, "note", b.note, 4000);

  const events: KsEventInput[] = [];
  if (b.events !== undefined && b.events !== null) {
    if (!Array.isArray(b.events)) errors.events = "must be a list";
    else if (b.events.length > 50) errors.events = "at most 50 events";
    else {
      b.events.forEach((e, i) => {
        if (!isPlainObject(e)) {
          errors[`events.${i}`] = "must be an object";
          return;
        }
        if (typeof e.type !== "string" || !(KS_EVENT_TYPES as readonly string[]).includes(e.type)) {
          errors[`events.${i}.type`] = "must be one of " + KS_EVENT_TYPES.join(", ");
          return;
        }
        const at = typeof e.at === "string" ? new Date(e.at) : null;
        if (!at || Number.isNaN(at.getTime())) {
          errors[`events.${i}.at`] = "must be an ISO-8601 date";
          return;
        }
        const summary = optText(errors, `events.${i}.summary`, e.summary, 300);
        events.push({ type: e.type as KsEventType, at: at.toISOString(), summary });
      });
    }
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { source: source as KsSource, external_id: externalId, stage, contact, company, note, events } };
}

function splitName(name: string | null, email: string | null, phone: string | null): { first: string; last: string } {
  const full = (name ?? "").trim();
  if (full) {
    const parts = full.split(/\s+/);
    return { first: parts[0]!, last: parts.slice(1).join(" ") };
  }
  if (email) return { first: email.split("@")[0]!, last: "" };
  return { first: phone ?? "Keystone contact", last: "" };
}

function last10(phone: string | null | undefined): string {
  const d = String(phone ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

async function findCompany(q: Q, refCompanyId: string | null, input: KsCompanyInput | null): Promise<{ id: string; ks_stage: string | null } | null> {
  if (refCompanyId) {
    const r = await q.query(`SELECT id::text AS id, ks_stage FROM companies WHERE id = $1 AND silo = 'KS'`, [refCompanyId]);
    if (r.rows[0]) return r.rows[0];
  }
  if (!input) return null;
  if (input.company_code) {
    const r = await q.query(
      `SELECT id::text AS id, ks_stage FROM companies WHERE silo = 'KS' AND lower(ks_company_code) = lower($1) ORDER BY created_at ASC LIMIT 1`,
      [input.company_code],
    );
    if (r.rows[0]) return r.rows[0];
  }
  if (input.name) {
    const r = await q.query(
      `SELECT id::text AS id, ks_stage FROM companies WHERE silo = 'KS' AND lower(name) = lower($1) ORDER BY created_at ASC LIMIT 1`,
      [input.name],
    );
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

async function findContact(q: Q, refContactId: string | null, input: KsContactInput | null): Promise<{ id: string; ks_stage: string | null } | null> {
  if (refContactId) {
    // Follow a merge to the surviving contact; never return an archived record.
    const r = await q.query(
      `SELECT coalesce(surv.id, c.id)::text AS id, coalesce(surv.ks_stage, c.ks_stage) AS ks_stage
         FROM contacts c
         LEFT JOIN contacts surv ON surv.id = c.merged_into_id AND surv.merged_into_id IS NULL AND coalesce(surv.status, '') <> 'archived'
        WHERE c.id = $1 AND c.silo = 'KS'
          AND (surv.id IS NOT NULL OR coalesce(c.status, '') <> 'archived')`,
      [refContactId],
    );
    if (r.rows[0]) return r.rows[0];
  }
  if (!input) return null;
  if (input.email) {
    const r = await q.query(
      `SELECT id::text AS id, ks_stage FROM contacts
        WHERE silo = 'KS' AND lower(email) = lower($1) AND merged_into_id IS NULL AND coalesce(status, '') <> 'archived'
        ORDER BY created_at ASC LIMIT 1`,
      [input.email],
    );
    if (r.rows[0]) return r.rows[0];
  }
  const p10 = last10(input.phone);
  if (p10) {
    const r = await q.query(
      `SELECT id::text AS id, ks_stage FROM contacts
        WHERE silo = 'KS' AND merged_into_id IS NULL AND coalesce(status, '') <> 'archived'
          AND (right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $1
               OR right(regexp_replace(coalesce(secondary_phone, ''), '[^0-9]', '', 'g'), 10) = $1)
        ORDER BY created_at ASC LIMIT 1`,
      [p10],
    );
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

async function addTimelineNote(
  q: Q,
  dedupeKey: string | null,
  body: string,
  ids: { contactId: string | null; companyId: string | null },
  at: string | null,
): Promise<boolean> {
  if (!ids.contactId && !ids.companyId) return false;
  if (dedupeKey) {
    const claim = await q.query(
      `INSERT INTO ks_crm_timeline_keys (dedupe_key) VALUES ($1) ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key`,
      [dedupeKey],
    );
    if (!claim.rows[0]) return false;
  }
  const r = await q.query(
    `INSERT INTO crm_notes (body, contact_id, company_id, silo, created_at, updated_at)
     VALUES ($1, $2::uuid, $3::uuid, 'KS', coalesce($4::timestamptz, now()), now())
     RETURNING id::text AS id`,
    [body.slice(0, 5000), ids.contactId, ids.companyId, at],
  );
  if (dedupeKey && r.rows[0]?.id) {
    await q.query(`UPDATE ks_crm_timeline_keys SET crm_note_id = $2::uuid WHERE dedupe_key = $1`, [dedupeKey, r.rows[0].id]);
  }
  return true;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export type KsUpsertResult = { ok: true; contact_id: string | null; company_id: string | null; stage: KsStage | null; created: { contact: boolean; company: boolean } };

/**
 * The KS-Ops ingest. Runs on one connection inside a transaction the caller opened; a per-reference advisory lock
 * makes two concurrent pushes for the same KS-Ops record queue instead of creating duplicates.
 */
export async function upsertKsCrm(q: Q, input: KsUpsertInput): Promise<KsUpsertResult> {
  await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ks_crm:${input.source}:${input.external_id}`]);
  const refRes = await q.query(
    `SELECT contact_id::text AS contact_id, company_id::text AS company_id FROM ks_crm_refs WHERE source = $1 AND external_id = $2`,
    [input.source, input.external_id],
  );
  const ref = refRes.rows[0] ?? null;
  const created = { contact: false, company: false };

  // Company
  let company = await findCompany(q, ref?.company_id ?? null, input.company);
  if (!company && input.company) {
    const c = input.company;
    const ins = await q.query(
      `INSERT INTO companies (id, name, website, silo, ks_company_code, ks_plan, ks_seats, ks_status, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'KS', $3, $4, $5, $6, 'prospect', now(), now())
       RETURNING id::text AS id, ks_stage`,
      [c.name ?? c.company_code, c.website, c.company_code, c.plan, c.seats, c.status],
    );
    company = ins.rows[0];
    created.company = true;
  } else if (company && input.company) {
    const c = input.company;
    await q.query(
      `UPDATE companies
          SET name = coalesce($2, name),
              website = coalesce($3, website),
              ks_company_code = coalesce($4, ks_company_code),
              ks_plan = coalesce($5, ks_plan),
              ks_seats = coalesce($6, ks_seats),
              ks_status = coalesce($7, ks_status),
              updated_at = now()
        WHERE id = $1`,
      [company.id, c.name, c.website, c.company_code, c.plan, c.seats, c.status],
    );
  }

  // Contact
  let contact = await findContact(q, ref?.contact_id ?? null, input.contact);
  if (!contact && input.contact) {
    const c = input.contact;
    const { first, last } = splitName(c.name, c.email, c.phone);
    const row = await createContact(q as any, {
      first_name: first,
      last_name: last,
      email: c.email,
      phone: c.phone,
      role: "other",
      is_primary_applicant: false,
      company_id: company?.id ?? null,
      silo: KS_SILO,
      owner_id: null,
    });
    contact = { id: String(row.id), ks_stage: null };
    created.contact = true;
    if (c.title) await q.query(`UPDATE contacts SET job_title = $2 WHERE id = $1`, [contact.id, c.title]);
  } else if (contact && input.contact) {
    const c = input.contact;
    const { first, last } = splitName(c.name, null, null);
    await q.query(
      `UPDATE contacts
          SET name = coalesce($2, name),
              first_name = CASE WHEN $2::text IS NULL THEN first_name ELSE $3 END,
              last_name = CASE WHEN $2::text IS NULL THEN last_name ELSE $4 END,
              email = coalesce($5, email),
              phone = coalesce($6, phone),
              job_title = coalesce($7, job_title),
              updated_at = now()
        WHERE id = $1`,
      [contact.id, c.name, first, last, c.email, c.phone, c.title],
    );
  }
  if (contact && company) {
    await q.query(
      `UPDATE contacts SET company_id = $2::uuid, company_name = (SELECT name FROM companies WHERE id = $2::uuid), updated_at = now()
        WHERE id = $1 AND company_id IS DISTINCT FROM $2::uuid`,
      [contact.id, company.id],
    );
  }

  const ids = { contactId: contact?.id ?? null, companyId: company?.id ?? null };

  // Stage (forward only, never out of lost)
  const stageNotes: string[] = [];
  let contactStage: KsStage | null = null;
  let companyStage: KsStage | null = null;
  if (contact) {
    contactStage = nextAutoStage(contact.ks_stage, input.stage);
    if (contactStage !== contact.ks_stage) {
      await q.query(`UPDATE contacts SET ks_stage = $2, ks_stage_changed_at = now() WHERE id = $1`, [contact.id, contactStage]);
      if (contact.ks_stage) stageNotes.push(`${KS_STAGE_LABELS[contact.ks_stage as KsStage] ?? contact.ks_stage} -> ${KS_STAGE_LABELS[contactStage]}`);
    }
  }
  if (company) {
    companyStage = nextAutoStage(company.ks_stage, input.stage);
    if (companyStage !== company.ks_stage) {
      await q.query(`UPDATE companies SET ks_stage = $2, ks_stage_changed_at = now() WHERE id = $1`, [company.id, companyStage]);
      if (company.ks_stage && !contact) stageNotes.push(`${KS_STAGE_LABELS[company.ks_stage as KsStage] ?? company.ks_stage} -> ${KS_STAGE_LABELS[companyStage]}`);
    }
  }
  if (stageNotes.length) {
    await addTimelineNote(q, null, `Keystone stage: ${stageNotes[0]} (automatic, from the ${SOURCE_LABELS[input.source]})`, ids, null);
  }

  // Reference + demo progress
  const demoOpened = input.events.filter((e) => e.type === "demo_opened").map((e) => e.at).sort()[0] ?? null;
  const demoCompleted = input.events.filter((e) => e.type === "demo_completed").map((e) => e.at).sort()[0] ?? null;
  const latest = [...input.events].sort((a, b) => (a.at < b.at ? 1 : -1))[0] ?? null;
  await q.query(
    `INSERT INTO ks_crm_refs (source, external_id, contact_id, company_id, demo_opened_at, demo_completed_at,
                              last_event_type, last_event_at, last_event_summary, created_at, updated_at)
     VALUES ($1, $2, $3::uuid, $4::uuid, $5::timestamptz, $6::timestamptz, $7, $8::timestamptz, $9, now(), now())
     ON CONFLICT (source, external_id) DO UPDATE SET
       contact_id = coalesce(EXCLUDED.contact_id, ks_crm_refs.contact_id),
       company_id = coalesce(EXCLUDED.company_id, ks_crm_refs.company_id),
       demo_opened_at = coalesce(least(ks_crm_refs.demo_opened_at, EXCLUDED.demo_opened_at), ks_crm_refs.demo_opened_at, EXCLUDED.demo_opened_at),
       demo_completed_at = coalesce(ks_crm_refs.demo_completed_at, EXCLUDED.demo_completed_at),
       last_event_type = CASE WHEN EXCLUDED.last_event_at IS NOT NULL AND (ks_crm_refs.last_event_at IS NULL OR EXCLUDED.last_event_at >= ks_crm_refs.last_event_at)
                              THEN EXCLUDED.last_event_type ELSE ks_crm_refs.last_event_type END,
       last_event_summary = CASE WHEN EXCLUDED.last_event_at IS NOT NULL AND (ks_crm_refs.last_event_at IS NULL OR EXCLUDED.last_event_at >= ks_crm_refs.last_event_at)
                              THEN EXCLUDED.last_event_summary ELSE ks_crm_refs.last_event_summary END,
       last_event_at = greatest(ks_crm_refs.last_event_at, EXCLUDED.last_event_at),
       updated_at = now()`,
    [input.source, input.external_id, ids.contactId, ids.companyId, demoOpened, demoCompleted, latest?.type ?? null, latest?.at ?? null, latest?.summary ?? null],
  );

  // Timeline: the note once per (source, external_id, note), each event once per (external_id, type, at).
  if (input.note) {
    await addTimelineNote(
      q,
      `note:${input.source}:${input.external_id}:${sha(input.note)}`,
      `Keystone ${SOURCE_LABELS[input.source]}: ${input.note}`,
      ids,
      null,
    );
  }
  let newSteps = 0;
  for (const e of input.events) {
    const added = await addTimelineNote(
      q,
      `event:${input.external_id}:${e.type}:${e.at}`,
      `Keystone ${e.type.replace(/_/g, " ")}${e.summary ? ": " + e.summary : ""}`,
      ids,
      e.at,
    );
    if (added && e.type === "demo_step") newSteps += 1;
  }
  if (newSteps) {
    await q.query(`UPDATE ks_crm_refs SET demo_steps = demo_steps + $3 WHERE source = $1 AND external_id = $2`, [input.source, input.external_id, newSteps]);
  }

  return { ok: true, contact_id: ids.contactId, company_id: ids.companyId, stage: companyStage ?? contactStage, created };
}

export type KsPipelineCard = {
  kind: "company" | "contact";
  id: string;
  stage: KsStage;
  stage_changed_at: string | null;
  company_id: string | null;
  company_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  plan: string | null;
  seats: number | null;
  status: string | null;
  demo_opened_at: string | null;
  demo_steps: number;
  demo_completed_at: string | null;
  last_event_summary: string | null;
  last_event_at: string | null;
  updated_at: string | null;
  silo: "KS";
};

/**
 * The Keystone pipeline board: one card per Keystone company (with its first contact), plus one per Keystone contact
 * that has no company. A record with no stage yet shows as Lead.
 */
export async function listKsPipeline(q: Q, opts: { search?: string | null; limit?: number } = {}): Promise<KsPipelineCard[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 1000, 1), 2000);
  const search = (opts.search ?? "").trim();
  const params: unknown[] = [limit];
  let coFilter = "";
  let ctFilter = "";
  if (search) {
    params.push(`%${search}%`);
    coFilter = ` AND (co.name ILIKE $2 OR coalesce(co.ks_company_code, '') ILIKE $2 OR coalesce(pc.name, '') ILIKE $2 OR coalesce(pc.email, '') ILIKE $2)`;
    ctFilter = ` AND (coalesce(c.name, '') ILIKE $2 OR coalesce(c.email, '') ILIKE $2 OR coalesce(c.phone, '') ILIKE $2)`;
  }
  const sql = `
    WITH demo AS (
      SELECT r.contact_id, r.company_id,
             min(r.demo_opened_at) AS demo_opened_at,
             max(r.demo_steps) AS demo_steps,
             min(r.demo_completed_at) AS demo_completed_at,
             (array_agg(r.last_event_summary ORDER BY r.last_event_at DESC NULLS LAST))[1] AS last_event_summary,
             max(r.last_event_at) AS last_event_at
        FROM ks_crm_refs r
       GROUP BY r.contact_id, r.company_id
    ),
    cards AS (
      SELECT 'company'::text AS kind, co.id::text AS id, coalesce(co.ks_stage, 'lead') AS stage, co.ks_stage_changed_at AS stage_changed_at,
             co.id::text AS company_id, co.name AS company_name,
             pc.id::text AS contact_id, pc.name AS contact_name, pc.email AS contact_email, pc.phone AS contact_phone,
             co.ks_plan AS plan, co.ks_seats AS seats, co.ks_status AS status,
             d.demo_opened_at, coalesce(d.demo_steps, 0) AS demo_steps, d.demo_completed_at, d.last_event_summary, d.last_event_at,
             greatest(co.updated_at, d.last_event_at) AS updated_at
        FROM companies co
        LEFT JOIN LATERAL (
          SELECT c.id, c.name, c.email, c.phone FROM contacts c
           WHERE c.company_id = co.id AND c.silo = 'KS' AND c.merged_into_id IS NULL AND coalesce(c.status, '') <> 'archived'
           ORDER BY c.created_at ASC LIMIT 1
        ) pc ON true
        LEFT JOIN LATERAL (
          SELECT min(x.demo_opened_at) AS demo_opened_at, max(x.demo_steps) AS demo_steps, min(x.demo_completed_at) AS demo_completed_at,
                 (array_agg(x.last_event_summary ORDER BY x.last_event_at DESC NULLS LAST))[1] AS last_event_summary,
                 max(x.last_event_at) AS last_event_at
            FROM demo x WHERE x.company_id = co.id OR (pc.id IS NOT NULL AND x.contact_id = pc.id)
        ) d ON true
       WHERE co.silo = 'KS'${coFilter}
      UNION ALL
      SELECT 'contact'::text, c.id::text, coalesce(c.ks_stage, 'lead'), c.ks_stage_changed_at,
             NULL::text, NULL::text,
             c.id::text, c.name, c.email, c.phone,
             NULL::text, NULL::integer, NULL::text,
             d.demo_opened_at, coalesce(d.demo_steps, 0), d.demo_completed_at, d.last_event_summary, d.last_event_at,
             greatest(c.updated_at, d.last_event_at)
        FROM contacts c
        LEFT JOIN LATERAL (
          SELECT min(x.demo_opened_at) AS demo_opened_at, max(x.demo_steps) AS demo_steps, min(x.demo_completed_at) AS demo_completed_at,
                 (array_agg(x.last_event_summary ORDER BY x.last_event_at DESC NULLS LAST))[1] AS last_event_summary,
                 max(x.last_event_at) AS last_event_at
            FROM demo x WHERE x.contact_id = c.id
        ) d ON true
       WHERE c.silo = 'KS' AND c.company_id IS NULL AND c.merged_into_id IS NULL AND coalesce(c.status, '') <> 'archived'${ctFilter}
    )
    SELECT * FROM cards ORDER BY updated_at DESC NULLS LAST, id LIMIT $1`;
  const { rows } = await q.query(sql, params);
  return rows.map((r: any) => ({
    kind: r.kind,
    id: r.id,
    stage: isKsStage(r.stage) ? r.stage : "lead",
    stage_changed_at: r.stage_changed_at ? new Date(r.stage_changed_at).toISOString() : null,
    company_id: r.company_id ?? null,
    company_name: r.company_name ?? null,
    contact_id: r.contact_id ?? null,
    contact_name: r.contact_name ?? null,
    contact_email: r.contact_email ?? null,
    contact_phone: r.contact_phone ?? null,
    plan: r.plan ?? null,
    seats: r.seats == null ? null : Number(r.seats),
    status: r.status ?? null,
    demo_opened_at: r.demo_opened_at ? new Date(r.demo_opened_at).toISOString() : null,
    demo_steps: Number(r.demo_steps ?? 0),
    demo_completed_at: r.demo_completed_at ? new Date(r.demo_completed_at).toISOString() : null,
    last_event_summary: r.last_event_summary ?? null,
    last_event_at: r.last_event_at ? new Date(r.last_event_at).toISOString() : null,
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    silo: "KS",
  }));
}

/** Staff move a card (any stage, lost included). Returns null when the record is not a Keystone record. */
export async function setKsStage(
  q: Q,
  kind: "contact" | "company",
  id: string,
  stage: KsStage,
  staffName: string | null,
): Promise<{ id: string; kind: "contact" | "company"; stage: KsStage; previous: KsStage | null } | null> {
  const table = kind === "company" ? "companies" : "contacts";
  const cur = await q.query(`SELECT ks_stage FROM ${table} WHERE id = $1 AND silo = 'KS'`, [id]);
  if (!cur.rows[0]) return null;
  const previous = isKsStage(cur.rows[0].ks_stage) ? (cur.rows[0].ks_stage as KsStage) : null;
  if (previous !== stage) {
    await q.query(`UPDATE ${table} SET ks_stage = $2, ks_stage_changed_at = now(), updated_at = now() WHERE id = $1 AND silo = 'KS'`, [id, stage]);
    await addTimelineNote(
      q,
      null,
      `Keystone stage: ${KS_STAGE_LABELS[previous ?? "lead"]} -> ${KS_STAGE_LABELS[stage]}${staffName ? ` (moved by ${staffName})` : ""}`,
      kind === "company" ? { contactId: null, companyId: id } : { contactId: id, companyId: null },
      null,
    );
  }
  return { id, kind, stage, previous };
}

/** Who may use the Keystone CRM on BF-Server: Admins, and staff whose silo access includes KS. */
export function canUseKsCrm(user: { role?: unknown; silos?: unknown; silo?: unknown } | null | undefined): boolean {
  if (!user) return false;
  if (String(user.role ?? "").toLowerCase() === "admin") return true;
  const silos = Array.isArray(user.silos) ? user.silos.map((s) => String(s).toUpperCase()) : [];
  return silos.includes(KS_SILO) || String(user.silo ?? "").toUpperCase() === KS_SILO;
}
