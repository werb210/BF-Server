// BF_SERVER_v856_CRM_UNIFY - the company left-side panel: every company detail from the company record, falling
// back to the business section of its latest application (what the applicant typed) when the record is empty.
// Edits always write the company record (and keep the older duplicate columns in step).
import type { Q } from "./tags.js";

export type DetailField = {
  key: string;
  label: string;
  value: string | null;
  source: "company" | "application" | null;
  editable: boolean;
  type: "text" | "date" | "number" | "url" | "tel" | "owner" | "readonly";
  raw?: string | null;
};

type Spec = {
  key: string;
  label: string;
  columns: string[]; // read in order; the first is the canonical column, the rest are kept in step on edit
  app: string[]; // business-section keys on the application, in order
  type: DetailField["type"];
};

export const COMPANY_FIELDS: Spec[] = [
  { key: "name", label: "Company name", columns: ["name"], app: [], type: "text" },
  { key: "legal_name", label: "Legal name", columns: ["legal_name"], app: ["legalName", "legal_name", "companyName", "name"], type: "text" },
  { key: "dba_name", label: "Operating / DBA name", columns: ["dba_name"], app: ["dbaName", "dba", "operatingName", "doingBusinessAs", "businessName"], type: "text" },
  { key: "address", label: "Address", columns: ["address_street"], app: ["address", "streetAddress", "businessAddress", "street"], type: "text" },
  { key: "city", label: "City", columns: ["address_city", "city"], app: ["city"], type: "text" },
  { key: "province", label: "Province / State", columns: ["address_state", "province", "region"], app: ["state", "province", "region"], type: "text" },
  { key: "postal_code", label: "Postal / ZIP", columns: ["address_zip"], app: ["postalCode", "zip", "zipCode"], type: "text" },
  { key: "country", label: "Country", columns: ["address_country", "country"], app: ["country"], type: "text" },
  { key: "phone", label: "Phone", columns: ["phone"], app: ["phone", "phoneNumber", "businessPhone"], type: "tel" },
  { key: "website", label: "Website", columns: ["website"], app: ["website"], type: "url" },
  { key: "industry", label: "Industry", columns: ["industry"], app: ["industry"], type: "text" },
  { key: "entity_type", label: "Entity type", columns: ["business_structure"], app: ["businessStructure", "entityType", "businessType"], type: "text" },
  { key: "start_date", label: "Start date", columns: ["start_date"], app: ["startDate"], type: "date" },
  { key: "time_in_business", label: "Time in business", columns: ["time_in_business"], app: ["timeInBusiness", "yearsInBusiness"], type: "text" },
  { key: "employees", label: "Employees", columns: ["employee_count", "number_of_employees"], app: ["numberOfEmployees", "employees", "employeeCount"], type: "number" },
  { key: "annual_revenue", label: "Annual revenue", columns: ["estimated_annual_revenue", "annual_revenue"], app: ["annualRevenue", "estimatedRevenue"], type: "number" },
  { key: "domain", label: "Domain", columns: ["domain"], app: [], type: "text" },
];

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const clean = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const t = String(v).replace(/\s+/g, " ").trim();
  return t ? t : null;
};

/** The business section of an application (same order the application page uses). */
export function businessSection(metadata: unknown): { business: Record<string, any>; kyc: Record<string, any> } {
  const md = isObj(metadata) ? metadata : {};
  const fd = isObj(md.formData) ? md.formData : {};
  const bp = isObj(md.broker_prefill) ? md.broker_prefill : {};
  const business = [md.company, md.business, fd.business, bp.business].find(isObj) ?? {};
  const kyc = [md.kyc, md.kyc_responses, md.financialProfile, fd.kyc, bp.kyc].find(isObj) ?? {};
  return { business, kyc };
}

export function domainOf(website: unknown, email?: unknown): string | null {
  const w = clean(website);
  if (w) {
    try {
      const host = new URL(/^https?:\/\//i.test(w) ? w : `https://${w}`).hostname.toLowerCase().replace(/^www\./, "");
      if (host.includes(".")) return host;
    } catch { /* fall through */ }
  }
  const m = /@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(String(email ?? "").trim());
  return m?.[1]?.toLowerCase() ?? null;
}

export function buildCompanyDetails(company: Record<string, any>, app: { metadata?: unknown; business_legal_name?: unknown } | null, owner: { name: string | null }): DetailField[] {
  const { business, kyc } = businessSection(app?.metadata);
  const fields: DetailField[] = COMPANY_FIELDS.map((f) => {
    let value: string | null = null;
    let source: DetailField["source"] = null;
    for (const c of f.columns) { const v = clean(company[c]); if (v) { value = v; source = "company"; break; } }
    if (!value) {
      for (const k of f.app) {
        const v = clean(business[k]) ?? (f.key === "industry" || f.key === "time_in_business" || f.key === "annual_revenue" ? clean(kyc[k]) : null);
        if (v) { value = v; source = "application"; break; }
      }
      if (!value && f.key === "legal_name") { const v = clean(app?.business_legal_name); if (v) { value = v; source = "application"; } }
    }
    return { key: f.key, label: f.label, value, source, editable: true, type: f.type };
  });
  const domain = fields.find((f) => f.key === "domain")!;
  if (!domain.value) {
    const website = fields.find((f) => f.key === "website")?.value;
    const d = domainOf(website, company.email);
    if (d) { domain.value = d; domain.source = website ? (fields.find((f) => f.key === "website")!.source) : "company"; }
  }
  fields.push({ key: "owner_id", label: "Owner", value: owner.name, raw: company.owner_id ? String(company.owner_id) : null, source: company.owner_id ? "company" : null, editable: true, type: "owner" });
  fields.push({ key: "created_at", label: "Created", value: clean(company.created_at instanceof Date ? company.created_at.toISOString() : company.created_at), source: "company", editable: false, type: "readonly" });
  return fields;
}

export async function companyDetails(db: Q, companyId: string, silo: string): Promise<{ company: Record<string, any>; fields: DetailField[] } | null> {
  const co = (await db.query(
    `SELECT co.*, nullif(btrim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '') AS owner_name
       FROM companies co LEFT JOIN users u ON u.id = co.owner_id
      WHERE co.id = $1::uuid AND co.silo = $2 LIMIT 1`,
    [companyId, silo],
  )).rows[0];
  if (!co) return null;
  const app = (await db.query(
    `SELECT metadata, business_legal_name FROM applications WHERE company_id = $1::uuid AND silo = $2
      ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [companyId, silo],
  )).rows[0] ?? null;
  return { company: co, fields: buildCompanyDetails(co, app, { name: co.owner_name ?? null }) };
}

/** Validated column updates for PATCH .../details; unknown keys are ignored, bad values refused. */
export function detailUpdates(body: Record<string, unknown>): { ok: true; sets: Array<[string, unknown]> } | { ok: false; field: string; error: string } {
  const sets: Array<[string, unknown]> = [];
  for (const [key, raw] of Object.entries(body ?? {})) {
    if (key === "owner_id") {
      const v = raw == null || raw === "" ? null : String(raw);
      if (v && !/^[0-9a-f-]{36}$/i.test(v)) return { ok: false, field: key, error: "owner must be a staff user" };
      sets.push(["owner_id", v]);
      continue;
    }
    const spec = COMPANY_FIELDS.find((f) => f.key === key);
    if (!spec) continue;
    let v: unknown = raw == null ? null : String(raw).replace(/\s+/g, " ").trim().slice(0, 300);
    if (v === "") v = null;
    if (spec.key === "name" && !v) return { ok: false, field: key, error: "Company name is required" };
    if (spec.type === "date" && v != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return { ok: false, field: key, error: "Use the format yyyy-mm-dd" };
    if (spec.type === "number" && v != null) {
      const n = Number(String(v).replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n) || n < 0) return { ok: false, field: key, error: "Enter a number" };
      v = spec.key === "employees" ? Math.round(n) : n;
    }
    if (spec.key === "domain" && v != null) v = domainOf(v) ?? String(v).toLowerCase();
    for (const c of spec.columns) sets.push([c, v]);
  }
  return { ok: true, sets };
}
