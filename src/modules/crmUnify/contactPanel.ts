// BF_SERVER_v856_CRM_UNIFY - the contact page's left panel, the same shape in every silo (BI-Server serves it too):
// the contact's applications (business, amount, product, stage, submitted date, partners, link) and the advisors
// linked to them. Unfinished drafts are collapsed: once a person has submitted, their abandoned drafts are only counted.
import type { Q } from "./tags.js";
import { applicationPeople } from "./people.js";

export type PanelApplication = {
  id: string;
  business: string | null;
  amount: number | null;
  product: string | null;
  stage: string | null;
  submitted: boolean;
  submittedAt: string | null;
  createdAt: string | null;
  role: string;
  partners: Array<{ contactId: string | null; name: string; role: string; email: string | null; phone: string | null }>;
  link: string;
};

const iso = (v: unknown): string | null => (v ? new Date(v as any).toISOString() : null);
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export async function contactApplications(db: Q, contactId: string, silo: string): Promise<{ applications: PanelApplication[]; drafts: number }> {
  const r = await db.query(
    `SELECT a.id::text AS id, a.metadata, a.requested_amount, a.submitted_at, a.created_at, a.updated_at,
            coalesce(nullif(btrim(a.business_legal_name), ''), nullif(btrim(co.name), ''),
                     nullif(btrim(a.metadata->'business'->>'companyName'), ''), nullif(btrim(a.metadata->'business'->>'legalName'), ''),
                     nullif(btrim(a.metadata->'formData'->'business'->>'companyName'), ''), nullif(btrim(a.name), '')) AS business,
            coalesce(nullif(a.product_category, ''), nullif(a.metadata->>'product_category', ''), nullif(a.product_type, '')) AS product,
            coalesce(nullif(a.current_stage, ''), nullif(a.pipeline_state, ''), nullif(a.status, '')) AS stage,
            CASE WHEN a.contact_id = $1::uuid THEN 'applicant'
                 ELSE coalesce((SELECT ac.role FROM application_contacts ac WHERE ac.application_id = a.id AND ac.contact_id = $1::uuid LIMIT 1), 'other') END AS role
       FROM applications a
       LEFT JOIN companies co ON co.id = a.company_id
      WHERE a.silo = $2
        AND (a.contact_id = $1::uuid OR a.id IN (SELECT application_id FROM application_contacts WHERE contact_id = $1::uuid))
      ORDER BY (a.submitted_at IS NOT NULL) DESC, a.updated_at DESC NULLS LAST
      LIMIT 50`,
    [contactId, silo],
  );
  const rows = r.rows as any[];
  const submitted = rows.filter((x) => x.submitted_at);
  // Keep every submitted application; of the unfinished drafts keep only the newest, and only when nothing was submitted.
  const shown = submitted.length ? submitted : rows.slice(0, 1);
  const drafts = rows.filter((x) => !x.submitted_at).length - (submitted.length ? 0 : Math.min(1, rows.length));
  const ids = shown.map((x) => String(x.id));
  const linked = ids.length
    ? ((await db.query(
        `SELECT ac.application_id, ac.role, c.id::text AS contact_id, c.name, c.email, c.phone
           FROM application_contacts ac JOIN contacts c ON c.id = ac.contact_id
          WHERE ac.application_id = ANY($1::text[]) AND ac.role IN ('partner', 'guarantor') AND c.merged_into_id IS NULL`,
        [ids],
      )).rows as any[])
    : [];
  const applications = shown.map((x): PanelApplication => {
    const partners: PanelApplication["partners"] = linked
      .filter((p) => String(p.application_id) === String(x.id))
      .map((p) => ({ contactId: String(p.contact_id), name: p.name ?? p.email ?? "(no name)", role: p.role, email: p.email ?? null, phone: p.phone ?? null }));
    for (const p of applicationPeople(x.metadata)) {
      const known = partners.some((k) => (p.email && k.email && k.email.toLowerCase() === p.email) || (p.name && k.name.toLowerCase() === p.name.toLowerCase()));
      if (!known) partners.push({ contactId: null, name: p.name ?? p.email ?? "(no name)", role: p.role, email: p.email, phone: p.phone });
    }
    const md = (x.metadata && typeof x.metadata === "object" ? x.metadata : {}) as any;
    return {
      id: String(x.id),
      business: x.business ?? null,
      amount: num(x.requested_amount) ?? num(md?.formData?.financialProfile?.fundingAmount) ?? num(md?.financialProfile?.fundingAmount) ?? num(md?.kyc?.fundingAmount),
      product: x.product ?? null,
      stage: x.stage ?? null,
      submitted: Boolean(x.submitted_at),
      submittedAt: iso(x.submitted_at),
      createdAt: iso(x.created_at),
      role: String(x.role ?? "applicant"),
      partners,
      link: `/applications/${encodeURIComponent(String(x.id))}`,
    };
  });
  return { applications, drafts: Math.max(0, drafts) };
}

export type RelatedPerson = { contactId: string; name: string; email: string | null; phone: string | null; company: string | null; detail: string | null; direction: "advisor" | "client" };

export async function contactRelated(db: Q, contactId: string, silo: string): Promise<RelatedPerson[]> {
  const r = await db.query(
    `SELECT 'advisor' AS direction, l.detail, c.id::text AS id, c.name, c.email, c.phone, co.name AS company
       FROM crm_contact_links l JOIN contacts c ON c.id = l.related_contact_id LEFT JOIN companies co ON co.id = c.company_id
      WHERE l.contact_id = $1::uuid AND l.silo = $2 AND c.merged_into_id IS NULL
     UNION ALL
     SELECT 'client' AS direction, l.detail, c.id::text AS id, c.name, c.email, c.phone, co.name AS company
       FROM crm_contact_links l JOIN contacts c ON c.id = l.contact_id LEFT JOIN companies co ON co.id = c.company_id
      WHERE l.related_contact_id = $1::uuid AND l.silo = $2 AND c.merged_into_id IS NULL
      ORDER BY 1, 4`,
    [contactId, silo],
  );
  return r.rows.map((x: any) => ({
    contactId: String(x.id), name: x.name ?? x.email ?? "(no name)", email: x.email ?? null, phone: x.phone ?? null,
    company: x.company ?? null, detail: x.detail ?? null, direction: x.direction === "client" ? "client" : "advisor",
  }));
}

// BF_SERVER_v856_CRM_UNIFY - one row per real stage move. Once the person has submitted, the events of their unfinished
// drafts are dropped; while nothing is submitted, the drafts' identical events ("Received application_created" from
// seven restarts) show once.
export function dedupeStageEvents<T extends { application_id?: unknown; from_stage?: unknown; to_stage?: unknown; trigger?: unknown; app_submitted?: unknown }>(rows: T[]): T[] {
  const anySubmitted = rows.some((r) => r.app_submitted === true);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const draft = r.app_submitted !== true;
    if (draft && anySubmitted) continue;
    const key = draft
      ? `draft|${r.from_stage ?? ""}|${r.to_stage ?? ""}|${r.trigger ?? ""}`
      : `${r.application_id}|${r.from_stage ?? ""}|${r.to_stage ?? ""}|${r.trigger ?? ""}`;
    if (draft && seen.has(key)) continue;
    seen.add(key);
    const rest: any = { ...(r as any) };
    delete rest.app_submitted;
    out.push(rest as T);
  }
  return out;
}
