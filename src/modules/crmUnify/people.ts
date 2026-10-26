// BF_SERVER_v856_CRM_UNIFY - everyone linked to a company, grouped by role, from every place they are recorded:
//   primary applicant   applications.contact_id of the company's applications (+ contacts flagged primary applicant)
//   partners/guarantors application_contacts rows, the application's own partner / owners / additional shareholders /
//                       guarantors (metadata and formData), and contacts with that role
//   advisors            the client's Professional Advisors form (application_form_responses 'professional_advisors')
//   other               every other contact with company_id = the company, and people staff added by hand
// People staff added by hand (crm_company_people) keep the role they were given. "Remove from company" hides an
// entry (crm_company_people_hidden), drops a hand-made association and clears contacts.company_id. Silo-scoped.
import type { Q } from "./tags.js";

export const PERSON_ROLES = ["primary_applicant", "partner", "guarantor", "accountant", "lawyer", "bookkeeper", "advisor", "employee", "other"] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];
export const ROLE_LABELS: Record<PersonRole, string> = {
  primary_applicant: "Primary applicant", partner: "Partner", guarantor: "Guarantor", accountant: "Accountant",
  lawyer: "Lawyer", bookkeeper: "Bookkeeper", advisor: "Advisor", employee: "Employee", other: "Other",
};
export type PersonGroup = "primary" | "partners" | "guarantors" | "advisors" | "other";
export const GROUP_LABELS: Record<PersonGroup, string> = {
  primary: "Primary applicant", partners: "Partners", guarantors: "Guarantors", advisors: "Advisors", other: "Other people",
};

export type Person = {
  key: string;
  contactId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  role: PersonRole;
  roleLabel: string;
  detail: string | null;
  source: "application" | "company" | "association" | "advisor_form";
  group: PersonGroup;
};

export function isPersonRole(v: unknown): v is PersonRole {
  return typeof v === "string" && (PERSON_ROLES as readonly string[]).includes(v);
}

export function groupFor(role: PersonRole): PersonGroup {
  if (role === "primary_applicant") return "primary";
  if (role === "partner") return "partners";
  if (role === "guarantor") return "guarantors";
  if (role === "accountant" || role === "lawyer" || role === "bookkeeper" || role === "advisor") return "advisors";
  return "other";
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const s = (...vals: unknown[]): string | null => {
  for (const v of vals) {
    if (v == null) continue;
    const t = String(v).replace(/\s+/g, " ").trim();
    if (t) return t;
  }
  return null;
};

export function personFromObject(o: unknown): { name: string | null; email: string | null; phone: string | null; title: string | null } {
  const p = isObj(o) ? o : {};
  const first = s(p.firstName, p.first_name);
  const last = s(p.lastName, p.last_name);
  return {
    name: s(p.fullName, p.full_name, p.name, [first, last].filter(Boolean).join(" ")),
    email: s(p.email)?.toLowerCase() ?? null,
    phone: s(p.phone, p.mobile, p.mobilePhone, p.cellPhone, p.phoneNumber),
    title: s(p.title),
  };
}

function flatPartner(src: Record<string, any>): Record<string, unknown> | null {
  const get = (k: string) => src[k];
  const f = {
    firstName: get("partnerFirstName"), lastName: get("partnerLastName"), email: get("partnerEmail"),
    phone: get("partnerPhone"), title: get("partnerTitle"),
  };
  return Object.values(f).some((v) => v != null && String(v).trim() !== "") ? f : null;
}

/** Partners and guarantors the applicant typed into the application (no contact record needed). */
export function applicationPeople(metadata: unknown): Array<{ role: "partner" | "guarantor"; name: string | null; email: string | null; phone: string | null; title: string | null }> {
  const md = isObj(metadata) ? metadata : {};
  const fd = isObj(md.formData) ? md.formData : {};
  const applicant = isObj(md.applicant) ? md.applicant : {};
  const fdApplicant = isObj(fd.applicant) ? fd.applicant : {};
  const partners: unknown[] = [];
  for (const p of [md.partner, applicant.partner, fdApplicant.partner, flatPartner(applicant), flatPartner(fdApplicant)]) if (isObj(p)) partners.push(p);
  for (const list of [md.partners, md.owners, applicant.additionalShareholders, fdApplicant.additionalShareholders, md.additionalShareholders]) {
    if (Array.isArray(list)) partners.push(...list.filter(isObj));
  }
  const guarantors: unknown[] = [];
  for (const list of [md.guarantors, fd.guarantors, applicant.guarantors]) if (Array.isArray(list)) guarantors.push(...list.filter(isObj));
  if (isObj(md.guarantor)) guarantors.push(md.guarantor);
  const out: Array<{ role: "partner" | "guarantor"; name: string | null; email: string | null; phone: string | null; title: string | null }> = [];
  for (const p of partners) out.push({ role: "partner", ...personFromObject(p) });
  for (const g of guarantors) out.push({ role: "guarantor", ...personFromObject(g) });
  return out.filter((p) => p.name || p.email);
}

const ADVISOR_KEYS: Record<string, PersonRole> = {
  cpa: "accountant", accountant: "accountant", bookkeeper: "bookkeeper", attorney: "lawyer", lawyer: "lawyer",
  insurance: "advisor", ar_credit_insurance: "advisor", financial_advisor: "advisor", banker: "advisor",
};
const ADVISOR_DETAIL: Record<string, string> = { insurance: "Insurance", ar_credit_insurance: "A/R credit insurance", financial_advisor: "Financial advisor", banker: "Banker" };

/** People on the Professional Advisors form: { advisors: { cpa: { firm, contact, phone, email }, attorney: {...} } }. */
export function advisorPeople(formData: unknown): Array<{ role: PersonRole; name: string | null; email: string | null; phone: string | null; detail: string | null }> {
  const d = isObj(formData) ? formData : {};
  const adv = isObj(d.advisors) ? d.advisors : {};
  const out: Array<{ role: PersonRole; name: string | null; email: string | null; phone: string | null; detail: string | null }> = [];
  const entries: Array<[string, unknown]> = Array.isArray(d.advisors)
    ? (d.advisors as unknown[]).map((row) => [String((row as any)?.type ?? (row as any)?.role ?? "advisor").toLowerCase(), row])
    : Object.entries(adv);
  for (const [k, row] of entries) {
    if (!isObj(row)) continue;
    const role = ADVISOR_KEYS[k] ?? "advisor";
    const name = s(row.contact, row.name, row.contactName, [row.firstName, row.lastName].filter(Boolean).join(" "));
    const firm = s(row.firm, row.company, row.firmName);
    const email = s(row.email)?.toLowerCase() ?? null;
    const phone = s(row.phone, row.mobile);
    if (!name && !firm && !email && !phone) continue;
    out.push({ role, name: name ?? firm, email, phone, detail: [ADVISOR_DETAIL[k], name && firm ? firm : null].filter(Boolean).join(" - ") || null });
  }
  return out;
}

export function personKey(p: { contactId?: string | null; email?: string | null; name?: string | null }): string {
  if (p.contactId) return `contact:${p.contactId}`;
  if (p.email) return `email:${p.email.toLowerCase()}`;
  return `name:${String(p.name ?? "").toLowerCase().replace(/\s+/g, " ").trim()}`;
}

const ROLE_RANK: Record<PersonGroup, number> = { primary: 0, partners: 1, guarantors: 2, advisors: 3, other: 4 };

export async function companyPeople(db: Q, companyId: string, silo: string): Promise<{ groups: Record<PersonGroup, Person[]>; people: Person[] }> {
  const apps = (await db.query(
    `SELECT a.id::text AS id, a.contact_id::text AS contact_id, a.metadata
       FROM applications a
      WHERE a.silo = $2
        AND (a.company_id = $1::uuid
             -- an application filed under another company record still belongs to the person who is on this one
             OR a.contact_id IN (SELECT id FROM contacts WHERE company_id = $1::uuid AND silo = $2 AND merged_into_id IS NULL))
      ORDER BY a.updated_at DESC NULLS LAST
      LIMIT 50`,
    [companyId, silo],
  )).rows as Array<{ id: string; contact_id: string | null; metadata: unknown }>;
  const appIds = apps.map((a) => a.id);

  const contacts = (await db.query(
    `SELECT c.id::text AS id, c.name, c.first_name, c.last_name, c.email, c.phone, c.role, c.is_primary_applicant, c.job_title,
            c.company_id::text AS company_id,
            (SELECT ac.role FROM application_contacts ac WHERE ac.contact_id = c.id AND ac.application_id = ANY($3::text[]) ORDER BY ac.created_at LIMIT 1) AS app_role,
            (SELECT cp.role FROM crm_company_people cp WHERE cp.contact_id = c.id AND cp.company_id = $1::uuid LIMIT 1) AS assoc_role,
            (SELECT cp.detail FROM crm_company_people cp WHERE cp.contact_id = c.id AND cp.company_id = $1::uuid LIMIT 1) AS assoc_detail,
            EXISTS (SELECT 1 FROM applications a WHERE a.contact_id = c.id AND a.id = ANY($3::text[])) AS is_app_primary
       FROM contacts c
      WHERE c.silo = $2
        AND coalesce(c.status, 'active') <> 'archived'
        AND c.merged_into_id IS NULL
        AND (c.company_id = $1::uuid
          OR c.id IN (SELECT contact_id FROM crm_company_people WHERE company_id = $1::uuid)
          OR c.id IN (SELECT contact_id FROM applications WHERE id = ANY($3::text[]) AND contact_id IS NOT NULL)
          OR c.id IN (SELECT contact_id FROM application_contacts WHERE application_id = ANY($3::text[])))
      LIMIT 500`,
    [companyId, silo, appIds],
  )).rows as any[];

  const hidden = new Set((await db.query(`SELECT person_key FROM crm_company_people_hidden WHERE company_id = $1::uuid`, [companyId])).rows.map((r: any) => String(r.person_key)));

  const forms = appIds.length
    ? (await db.query(
        `SELECT application_id, data FROM application_form_responses WHERE application_id = ANY($1::text[]) AND doc_type = 'professional_advisors'`,
        [appIds],
      )).rows as Array<{ application_id: string; data: unknown }>
    : [];

  const people: Person[] = [];
  const byKey = new Map<string, Person>();
  const byEmail = new Map<string, Person>();
  const add = (p: Omit<Person, "key" | "group" | "roleLabel">) => {
    const key = personKey(p);
    if (hidden.has(key) || (p.email && hidden.has(`email:${p.email}`))) return;
    const existing = byKey.get(key) ?? (p.email ? byEmail.get(p.email) : undefined);
    const group = groupFor(p.role);
    if (existing) {
      // Keep the more specific role (primary > partner > guarantor > advisor > other) and fill gaps.
      if (ROLE_RANK[group] < ROLE_RANK[existing.group]) { existing.role = p.role; existing.group = group; existing.roleLabel = ROLE_LABELS[p.role]; }
      existing.contactId = existing.contactId ?? p.contactId;
      existing.email = existing.email ?? p.email;
      existing.phone = existing.phone ?? p.phone;
      existing.detail = existing.detail ?? p.detail;
      return;
    }
    const person: Person = { ...p, key, group, roleLabel: ROLE_LABELS[p.role] };
    people.push(person);
    byKey.set(key, person);
    if (p.email) byEmail.set(p.email, person);
  };

  for (const c of contacts) {
    const appRole = String(c.app_role ?? "").toLowerCase();
    const contactRole = String(c.role ?? "").toLowerCase();
    let role: PersonRole = "other";
    let source: Person["source"] = "company";
    // The applicant is always the primary applicant, whatever older automatic links said.
    if (c.is_app_primary && (!isPersonRole(c.assoc_role) || c.assoc_role === "other" || c.assoc_role === "employee")) { role = "primary_applicant"; source = "application"; }
    else if (isPersonRole(c.assoc_role)) { role = c.assoc_role; source = "association"; }
    else if (c.is_app_primary || c.is_primary_applicant || appRole === "applicant" || contactRole === "applicant") { role = "primary_applicant"; source = c.is_app_primary || appRole ? "application" : "company"; }
    else if (appRole === "partner" || contactRole === "partner") { role = "partner"; source = appRole ? "application" : "company"; }
    else if (appRole === "guarantor" || contactRole === "guarantor") { role = "guarantor"; source = appRole ? "application" : "company"; }
    const name = s(c.name, [c.first_name, c.last_name].filter(Boolean).join(" "), c.email) ?? "(no name)";
    add({ contactId: String(c.id), name, email: s(c.email)?.toLowerCase() ?? null, phone: s(c.phone), role, detail: s(c.assoc_detail, c.job_title), source });
  }

  for (const app of apps) {
    for (const p of applicationPeople(app.metadata)) {
      add({ contactId: null, name: p.name ?? p.email ?? "(no name)", email: p.email, phone: p.phone, role: p.role, detail: p.title, source: "application" });
    }
  }
  for (const f of forms) {
    for (const a of advisorPeople(f.data)) {
      add({ contactId: null, name: a.name ?? a.email ?? "(no name)", email: a.email, phone: a.phone, role: a.role, detail: a.detail, source: "advisor_form" });
    }
  }

  // Link people typed into a form to an existing contact with the same email in this silo.
  const loose = people.filter((p) => !p.contactId && p.email).map((p) => p.email as string);
  if (loose.length) {
    const found = (await db.query(
      `SELECT DISTINCT ON (lower(email)) id::text AS id, lower(email) AS email FROM contacts
        WHERE silo = $1 AND lower(email) = ANY($2::text[]) AND coalesce(status, 'active') <> 'archived'
        ORDER BY lower(email), created_at ASC`,
      [silo, loose],
    )).rows as Array<{ id: string; email: string }>;
    for (const f of found) {
      const p = people.find((x) => !x.contactId && x.email === f.email);
      if (p && !people.some((x) => x.contactId === f.id)) p.contactId = f.id;
    }
  }

  people.sort((a, b) => ROLE_RANK[a.group] - ROLE_RANK[b.group] || a.name.localeCompare(b.name));
  const groups: Record<PersonGroup, Person[]> = { primary: [], partners: [], guarantors: [], advisors: [], other: [] };
  for (const p of people) groups[p.group].push(p);
  return { groups, people };
}
