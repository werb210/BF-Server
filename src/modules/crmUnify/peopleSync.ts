// BF_SERVER_v856_CRM_UNIFY - every person on an application becomes a CRM contact in the application's silo.
//   applicant           application_contacts 'applicant' + crm_company_people role primary_applicant
//   partner / guarantor matched by email, then phone (last 10 digits), else created; system tag partner / guarantor;
//                       application_contacts row and crm_company_people role partner / guarantor
//   advisors            each person on the Professional Advisors form: matched the same way, else created under their
//                       firm (their employer company); the matching core tag (Accountant/Bookkeeper, Lawyer,
//                       Insurance, A/R Credit Insurance); linked to the client contact (crm_contact_links) and to the
//                       client's company with role accountant / lawyer / advisor and the advisor type.
// Runs after submit, when the advisors form is submitted, and once over every existing application
// (backfillCrmPeopleOnce, recorded in crm_backfill_runs). Safe to run again: it only adds what is missing.
import type { Q } from "./tags.js";
import { normalizeTag } from "./tags.js";
import { applicationPeople, personFromObject } from "./people.js";

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const txt = (v: unknown): string | null => {
  if (v == null) return null;
  const t = String(v).replace(/\s+/g, " ").trim();
  return t || null;
};
const digits10 = (v: unknown): string | null => {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

export type AdvisorType = { key: string; tag: string; role: "accountant" | "lawyer" | "bookkeeper" | "advisor"; label: string };

/** Professional Advisors form key -> the shared core tag, the company-people role and the type staff see. */
export const ADVISOR_TYPES: Record<string, AdvisorType> = {
  cpa: { key: "cpa", tag: "accountant", role: "accountant", label: "Accountant (CPA)" },
  accountant: { key: "accountant", tag: "accountant", role: "accountant", label: "Accountant" },
  bookkeeper: { key: "bookkeeper", tag: "accountant", role: "bookkeeper", label: "Bookkeeper" },
  attorney: { key: "attorney", tag: "lawyer", role: "lawyer", label: "Lawyer" },
  lawyer: { key: "lawyer", tag: "lawyer", role: "lawyer", label: "Lawyer" },
  insurance: { key: "insurance", tag: "insurance", role: "advisor", label: "Insurance" },
  ar_credit_insurance: { key: "ar_credit_insurance", tag: "ar_credit_insurance", role: "advisor", label: "A/R credit insurance" },
};
export function advisorType(key: string): AdvisorType {
  const raw = String(key ?? "").trim().toLowerCase().replace(/[\s/-]+/g, "_");
  const k = normalizeTag(key);
  return ADVISOR_TYPES[raw] ?? ADVISOR_TYPES[k] ?? { key: k || "advisor", tag: "advisor", role: "advisor", label: "Advisor" };
}

export type AdvisorEntry = { type: AdvisorType; firm: string | null; name: string | null; email: string | null; phone: string | null };

/** People on the Professional Advisors form ({ advisors: { cpa: { firm, contact, email, phone }, ... } } or a list). */
export function advisorEntries(formData: unknown): AdvisorEntry[] {
  const d = isObj(formData) ? formData : {};
  const raw: Array<[string, unknown]> = Array.isArray(d.advisors)
    ? (d.advisors as unknown[]).map((row) => [String((row as any)?.type ?? (row as any)?.role ?? "advisor"), row])
    : Object.entries(isObj(d.advisors) ? d.advisors : {});
  const out: AdvisorEntry[] = [];
  for (const [key, row] of raw) {
    if (!isObj(row)) continue;
    const firm = txt(row.firm ?? row.company ?? row.firmName);
    const name = txt(row.contact ?? row.name ?? row.contactName ?? [row.firstName, row.lastName].filter(Boolean).join(" "));
    const email = txt(row.email)?.toLowerCase() ?? null;
    const phone = txt(row.phone ?? row.mobile);
    if (!firm && !name && !email && !phone) continue;
    out.push({ type: advisorType(key), firm, name, email, phone });
  }
  return out;
}

function splitName(full: string | null): { first: string; last: string } {
  const parts = String(full ?? "").split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

/** A live contact in the silo with this email, else this phone (last 10 digits). Merged and archived records never match.
 *  A phone match must also agree on the name (or the record is a placeholder), so two people sharing an office line
 *  are never folded into one. */
export async function findContactByEmailOrPhone(db: Q, silo: string, email: string | null, phone: string | null, name: string | null = null): Promise<{ id: string; company_id: string | null } | null> {
  if (email) {
    const r = await db.query(
      `SELECT id::text AS id, company_id::text AS company_id FROM contacts
        WHERE silo = $1 AND lower(btrim(email)) = $2 AND merged_into_id IS NULL AND coalesce(status, 'active') <> 'archived'
        ORDER BY created_at ASC LIMIT 1`,
      [silo, email.toLowerCase().trim()],
    );
    if (r.rows[0]) return r.rows[0];
  }
  const p10 = digits10(phone);
  if (p10) {
    const r = await db.query(
      `SELECT id::text AS id, company_id::text AS company_id FROM contacts
        WHERE silo = $1 AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $2
          AND merged_into_id IS NULL AND coalesce(status, 'active') <> 'archived'
          AND ($3::text IS NULL OR btrim(coalesce(name, '')) = '' OR name ILIKE '%application started%'
               OR lower(btrim(name)) = 'unknown' OR bf_same_person_name(name, $3::text))
        ORDER BY (coalesce(name, '') ILIKE '%application started%') ASC, created_at ASC LIMIT 1`,
      [silo, p10, name],
    );
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

type PersonInput = { name: string | null; email: string | null; phone: string | null; title?: string | null };

/** Find (email, then phone) or create the contact, add the tag and fill an empty company link. */
export async function upsertPersonContact(
  db: Q,
  silo: string,
  p: PersonInput,
  opts: { tag: string; role: "partner" | "guarantor" | "other"; companyId: string | null; ownerId: string | null },
): Promise<{ id: string; created: boolean } | null> {
  const name = txt(p.name);
  const email = txt(p.email)?.toLowerCase() ?? null;
  const phone = txt(p.phone);
  if (!name && !email && !phone) return null;
  const found = await findContactByEmailOrPhone(db, silo, email, phone, name);
  if (found) {
    await db.query(
      `UPDATE contacts
          SET tags = bf_norm_tags(coalesce(tags, '{}'::text[]) || ARRAY[$2]::text[]),
              company_id = coalesce(company_id, $3::uuid),
              role = CASE WHEN coalesce(role, 'unknown') IN ('unknown', 'other') AND $4 <> 'other' THEN $4 ELSE role END,
              name = CASE WHEN $5::text IS NOT NULL AND (btrim(coalesce(name, '')) = '' OR name ILIKE '%application started%' OR lower(btrim(name)) = 'unknown') THEN $5 ELSE name END,
              email = coalesce(nullif(btrim(email), ''), $6),
              phone = coalesce(nullif(btrim(phone), ''), $7),
              updated_at = now()
        WHERE id = $1::uuid`,
      [found.id, opts.tag, opts.companyId, opts.role, name, email, phone],
    );
    return { id: found.id, created: false };
  }
  const { first, last } = splitName(name ?? email ?? phone);
  const r = await db.query(
    `INSERT INTO contacts (silo, name, first_name, last_name, email, phone, company_id, owner_id, role, job_title, tags, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, $8::uuid, $9, $10, ARRAY[$11]::text[], 'prospect')
     RETURNING id::text AS id`,
    [silo, name ?? [first, last].filter(Boolean).join(" "), first || null, last || null, email, phone, opts.companyId, opts.ownerId, opts.role, txt(p.title), opts.tag],
  );
  return { id: String(r.rows[0].id), created: true };
}

async function linkCompanyPerson(db: Q, silo: string, companyId: string | null, contactId: string, role: string, detail: string | null, source: string): Promise<void> {
  if (!companyId) return;
  // A link staff made by hand keeps its role; a weaker automatic one ("other", "employee") is upgraded.
  await db.query(
    `INSERT INTO crm_company_people (silo, company_id, contact_id, role, detail, source)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6)
     ON CONFLICT (company_id, contact_id) DO UPDATE
        SET role = CASE WHEN crm_company_people.role IN ('other', 'employee') THEN EXCLUDED.role ELSE crm_company_people.role END,
            detail = coalesce(crm_company_people.detail, EXCLUDED.detail)`,
    [silo, companyId, contactId, role, detail, source],
  );
}

async function linkApplication(db: Q, applicationId: string, contactId: string, role: "applicant" | "partner" | "guarantor" | "other"): Promise<void> {
  await db.query(
    `INSERT INTO application_contacts (application_id, contact_id, role)
     SELECT $1, $2::uuid, $3
      WHERE NOT EXISTS (SELECT 1 FROM application_contacts WHERE application_id = $1 AND contact_id = $2::uuid AND role = $3)`,
    [applicationId, contactId, role],
  );
}

export type SyncResult = { applicationId: string; created: number; linked: number; advisors: number };

type AppRow = { id: string; silo: string; contact_id: string | null; company_id: string | null; metadata: unknown; owner_id: string | null };

async function loadApplication(db: Q, applicationId: string): Promise<AppRow | null> {
  const r = await db.query(
    `SELECT a.id::text AS id, upper(coalesce(a.silo, 'BF')) AS silo, a.contact_id::text AS contact_id,
            coalesce(a.company_id, c.company_id)::text AS company_id, a.metadata,
            coalesce(c.owner_id, a.owner_user_id)::text AS owner_id
       FROM applications a
       LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE a.id::text = $1
      LIMIT 1`,
    [applicationId],
  );
  return (r.rows[0] as AppRow) ?? null;
}

/** Advisors on one application's Professional Advisors form. */
export async function syncApplicationAdvisors(db: Q, applicationId: string, formData?: unknown): Promise<number> {
  const app = await loadApplication(db, applicationId);
  if (!app) return 0;
  let data = formData;
  if (data === undefined) {
    const f = await db.query(
      `SELECT data FROM application_form_responses WHERE application_id = $1 AND doc_type = 'professional_advisors' ORDER BY updated_at DESC LIMIT 1`,
      [applicationId],
    );
    data = f.rows[0]?.data;
  }
  let n = 0;
  for (const a of advisorEntries(data)) {
    // The advisor's firm is their employer company (same silo as the application).
    let firmId: string | null = null;
    if (a.firm) {
      const existing = await db.query(`SELECT id::text AS id FROM companies WHERE lower(btrim(name)) = lower(btrim($1)) AND silo = $2 ORDER BY created_at ASC LIMIT 1`, [a.firm, app.silo]);
      firmId = existing.rows[0]?.id ?? null;
      if (!firmId) {
        const created = await db.query(
          `INSERT INTO companies (id, name, silo, owner_id, tags) VALUES (gen_random_uuid(), $1, $2, $3::uuid, ARRAY[$4]::text[]) RETURNING id::text AS id`,
          [a.firm, app.silo, app.owner_id, a.type.tag],
        );
        firmId = String(created.rows[0].id);
      }
    }
    const person = await upsertPersonContact(db, app.silo, { name: a.name ?? a.firm, email: a.email, phone: a.phone }, {
      tag: a.type.tag, role: "other", companyId: firmId, ownerId: app.owner_id,
    });
    if (!person) continue;
    n++;
    if (app.contact_id && app.contact_id !== person.id) {
      await db.query(
        `INSERT INTO crm_contact_links (silo, contact_id, related_contact_id, relation, detail, application_id)
         VALUES ($1, $2::uuid, $3::uuid, 'advisor', $4, $5)
         ON CONFLICT (contact_id, related_contact_id, relation) DO UPDATE SET detail = EXCLUDED.detail`,
        [app.silo, app.contact_id, person.id, a.type.label, app.id],
      );
    }
    if (app.company_id && app.company_id !== firmId) {
      await linkCompanyPerson(db, app.silo, app.company_id, person.id, a.type.role, a.type.label, "advisor_form");
    }
  }
  return n;
}

/** Applicant, partners, guarantors and advisors of one application. */
export async function syncApplicationPeople(db: Q, applicationId: string): Promise<SyncResult> {
  const out: SyncResult = { applicationId, created: 0, linked: 0, advisors: 0 };
  const app = await loadApplication(db, applicationId);
  if (!app) return out;
  if (app.contact_id) {
    await linkApplication(db, app.id, app.contact_id, "applicant");
    await linkCompanyPerson(db, app.silo, app.company_id, app.contact_id, "primary_applicant", null, "application");
    out.linked++;
  }
  const seen = new Set<string>();
  for (const p of applicationPeople(app.metadata)) {
    const k = (p.email ?? "") + "|" + (digits10(p.phone) ?? "") + "|" + (p.name ?? "").toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const person = await upsertPersonContact(db, app.silo, p, { tag: p.role, role: p.role, companyId: app.company_id, ownerId: app.owner_id });
    if (!person || person.id === app.contact_id) continue;
    if (person.created) out.created++;
    await linkApplication(db, app.id, person.id, p.role);
    await linkCompanyPerson(db, app.silo, app.company_id, person.id, p.role, null, "application");
    out.linked++;
  }
  out.advisors = await syncApplicationAdvisors(db, app.id);
  return out;
}

/** Every application (newest first). Each one runs on its own; a failure is logged and the rest carry on. */
export async function backfillCrmPeople(db: Q, opts: { limit?: number } = {}): Promise<{ applications: number; created: number; linked: number; advisors: number; failed: number }> {
  const ids = (await db.query(
    `SELECT id::text AS id FROM applications
      WHERE contact_id IS NOT NULL
         OR metadata ? 'partner' OR metadata ? 'owners' OR metadata ? 'guarantors' OR metadata ? 'applicant' OR metadata ? 'formData'
         OR id IN (SELECT application_id FROM application_form_responses WHERE doc_type = 'professional_advisors')
      ORDER BY created_at DESC
      LIMIT $1`,
    [opts.limit ?? 50000],
  )).rows.map((r: any) => String(r.id));
  const total = { applications: ids.length, created: 0, linked: 0, advisors: 0, failed: 0 };
  for (const id of ids) {
    try {
      const r = await syncApplicationPeople(db, id);
      total.created += r.created;
      total.linked += r.linked;
      total.advisors += r.advisors;
    } catch (err) {
      total.failed++;
      console.warn("[crm_people_backfill] application failed", { applicationId: id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return total;
}

export const PEOPLE_BACKFILL_KEY = "v856_people_v1";

/** Runs the backfill once per database (the first instance to claim the key does it). */
export async function backfillCrmPeopleOnce(db: Q): Promise<{ ran: boolean; result?: unknown }> {
  const claim = await db.query(
    // A run that started over an hour ago and never finished (the instance restarted) is claimed again.
    `INSERT INTO crm_backfill_runs (key) VALUES ($1)
     ON CONFLICT (key) DO UPDATE SET started_at = now()
      WHERE crm_backfill_runs.finished_at IS NULL AND crm_backfill_runs.started_at < now() - interval '1 hour'
     RETURNING key`,
    [PEOPLE_BACKFILL_KEY],
  );
  if (!claim.rows.length) return { ran: false };
  const result = await backfillCrmPeople(db);
  await db.query(`UPDATE crm_backfill_runs SET finished_at = now(), result = $2::jsonb WHERE key = $1`, [PEOPLE_BACKFILL_KEY, JSON.stringify(result)]);
  console.log(JSON.stringify({ event: "crm_people_backfill", ...result }));
  return { ran: true, result };
}

export { personFromObject };
