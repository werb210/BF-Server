// BF_SERVER_MG_SHEET_REAL_COLUMNS_v1
// Loads a submitted application and maps it into a row matching Merchant Growth's ACTUAL
// Google Sheet template (received 2026-07-13). They ingest the sheet into Salesforce via
// G-Connector, which maps by COLUMN ORDER, so MERCHANT_GROWTH_COLUMNS below must stay in
// exactly the template's left-to-right order.
//
// The previous column list was a placeholder ("Submitted At", "Application ID", ...) that
// matched nothing in their sheet; a submission built from it would have landed in
// Salesforce with every field in the wrong column.
//
// Source of truth for the business fields is applications.metadata.business, written by
// the bf-client wizard Step 3 (Step3_Business.tsx), and metadata.applicant / metadata.kyc.
// Everything is defensive: a missing field becomes an empty cell rather than throwing.
import type { Pool } from "pg";

export type SheetRowData = {
  applicationId: string;
  firstName: string;
  lastName: string;
  company: string;
  email: string;
  mobile: string;          // 10 digits, no country code
  phone: string;           // 10 digits, no country code
  dob: string;             // YYYY-MM-DD
  language: string;        // English | French
  requestedAmount: string; // plain number
  annualRevenue: string;   // plain number
  monthlySales: string;    // plain number
  street: string;
  city: string;
  province: string;        // 2-letter
  country: string;
  postalCode: string;
  yearsInBusiness: string; // integer
  entityType: string;      // their vocabulary
  industry: string;        // their vocabulary
  useOfFunds: string;
};

function s(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return String(v).trim();
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// Their template says "(10 digits)". We store E.164 (+15878881837), so strip to the last
// 10 digits - sending "+1587..." into a 10-digit column would fail their validation.
export function toTenDigits(v: unknown): string {
  const digits = s(v).replace(/\D/g, "");
  if (!digits) return "";
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// Their column is an integer. We hold a business start date (Step 3), so derive it.
export function yearsSince(startDate: unknown, now: Date = new Date()): string {
  const raw = s(startDate);
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  let years = now.getFullYear() - d.getFullYear();
  const beforeAnniversary =
    now.getMonth() < d.getMonth() ||
    (now.getMonth() === d.getMonth() && now.getDate() < d.getDate());
  if (beforeAnniversary) years -= 1;
  return String(Math.max(0, years));
}

// Strip currency formatting: "$1,100,000" -> "1100000". Their columns are Currency.
export function toNumber(v: unknown): string {
  const raw = s(v).replace(/[^0-9.]/g, "");
  if (!raw) return "";
  const n = Number(raw);
  return Number.isFinite(n) ? String(Math.round(n)) : "";
}

// Their Entity Type dropdown. Our wizard's Business Structure values map straight across
// except for casing/wording; anything unrecognised is left EMPTY rather than guessed -
// a wrong entity type on a credit application is worse than a blank one.
const ENTITY_TYPES = [
  "Sole Proprietorship",
  "Corporation",
  "Limited Partnership",
  "Partnership",
  "General Partnership",
  "Partnership / Sole Proprietorship",
] as const;

export function mapEntityType(v: unknown): string {
  const raw = s(v).toLowerCase();
  if (!raw) return "";
  const hit = ENTITY_TYPES.find((e) => e.toLowerCase() === raw);
  if (hit) return hit;
  if (raw.includes("sole")) return "Sole Proprietorship";
  if (raw.includes("corp") || raw.includes("inc")) return "Corporation";
  if (raw.includes("limited partner")) return "Limited Partnership";
  if (raw.includes("general partner")) return "General Partnership";
  if (raw.includes("partner")) return "Partnership";
  return "";
}

// Their Industry dropdown. Ours (from the credit-readiness form) does not use the same
// words, and the instruction is to map onto THEIRS without changing ours. Anything we
// cannot place honestly goes to "Other", which is a value they explicitly offer.
const INDUSTRY_MAP: Record<string, string> = {
  "auto-related": "Auto-Related",
  automotive: "Auto-Related",
  construction: "Construction",
  "restaurant / food service": "Food & Beverage",
  restaurant: "Food & Beverage",
  "food & beverage": "Food & Beverage",
  "food service": "Food & Beverage",
  hospitality: "Food & Beverage",
  "hair & beauty": "Hair & Beauty",
  beauty: "Hair & Beauty",
  salon: "Hair & Beauty",
  health: "Health",
  healthcare: "Health",
  medical: "Health",
  "professional services": "Professional Services",
  professional: "Professional Services",
  consulting: "Professional Services",
  legal: "Professional Services",
  accounting: "Professional Services",
  recreation: "Recreation",
  entertainment: "Recreation",
  fitness: "Recreation",
  retail: "Retail",
  ecommerce: "Retail",
  wholesale: "Retail",
  transportation: "Transportation",
  trucking: "Transportation",
  logistics: "Transportation",
};

export function mapIndustry(v: unknown): string {
  const raw = s(v).toLowerCase();
  if (!raw) return "";
  if (INDUSTRY_MAP[raw]) return INDUSTRY_MAP[raw];
  for (const [k, val] of Object.entries(INDUSTRY_MAP)) {
    if (raw.includes(k) || k.includes(raw)) return val;
  }
  return "Other";
}

const PROVINCES = new Set(["BC", "AB", "SK", "MB", "ON", "QC", "NB", "NS", "PE", "NL", "YT", "NT", "NU"]);

export function mapProvince(v: unknown): string {
  const raw = s(v).toUpperCase();
  return PROVINCES.has(raw) ? raw : "";
}

export async function loadSheetRowData(pool: Pool, applicationId: string): Promise<SheetRowData> {
  const r = await pool
    .query<{
      application_id: string;
      business_name: string | null;
      requested_amount: string | number | null;
      metadata: unknown;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      phone: string | null;
      company_name: string | null;
      dob: string | null;
    }>(
      `SELECT a.id::text AS application_id,
              a.name AS business_name,
              a.requested_amount,
              a.metadata,
              c.first_name, c.last_name, c.email, c.phone, c.company_name,
              to_char(c.dob, 'YYYY-MM-DD') AS dob
         FROM applications a
         LEFT JOIN contacts c ON c.id = a.contact_id
        WHERE a.id::text = $1
        LIMIT 1`,
      [applicationId],
    )
    .catch(() => ({ rows: [] as never[] }));

  const row = Array.isArray(r.rows) ? r.rows[0] : undefined;
  const md = obj(row?.metadata);
  const business = obj(md.business);
  const applicant = obj(md.applicant);
  const kyc = obj(md.kyc) ?? obj(md.financial);

  return {
    applicationId,
    firstName: s(applicant.firstName) || s(row?.first_name),
    lastName: s(applicant.lastName) || s(row?.last_name),
    company: s(business.legalName) || s(business.companyName) || s(row?.business_name) || s(row?.company_name),
    email: s(applicant.email) || s(row?.email),
    mobile: toTenDigits(s(applicant.phone) || s(row?.phone)),
    phone: toTenDigits(s(business.phone) || s(applicant.phone) || s(row?.phone)),
    dob: s(applicant.dob) || s(row?.dob),
    // Default English. We never ask, so do not pretend to know.
    language: "English",
    requestedAmount: toNumber(row?.requested_amount ?? kyc.fundingAmount ?? kyc.requestedAmount),
    // Step 3 "Estimated Yearly Revenue" is an exact figure, unlike the readiness ranges.
    annualRevenue: toNumber(business.estimatedRevenue ?? kyc.annualRevenue),
    // They want a monthly figure; Step 3 only gives an annual one, so derive it rather
    // than sending a revenue RANGE string into a Currency column.
    monthlySales: (() => {
      const monthly = toNumber(kyc.monthlyRevenue);
      if (monthly) return monthly;
      const annual = Number(toNumber(business.estimatedRevenue ?? kyc.annualRevenue));
      return Number.isFinite(annual) && annual > 0 ? String(Math.round(annual / 12)) : "";
    })(),
    street: s(business.address),
    city: s(business.city),
    province: mapProvince(business.state),
    country: "Canada",
    postalCode: s(business.zip).toUpperCase(),
    yearsInBusiness: yearsSince(business.startDate),
    entityType: mapEntityType(business.businessStructure),
    industry: mapIndustry(kyc.industry ?? business.industry),
    useOfFunds: s(kyc.purposeOfFunds) || s(kyc.purpose),
  };
}

// MUST match Merchant Growth's template header row, left-to-right (20 columns).
// G-Connector maps by column order - reordering this silently corrupts every submission.
export const MERCHANT_GROWTH_COLUMNS: { header: string; get: (d: SheetRowData) => string }[] = [
  { header: "First Name", get: (d) => d.firstName },
  { header: "Last Name*", get: (d) => d.lastName },
  { header: "Company*", get: (d) => d.company },
  { header: "Email", get: (d) => d.email },
  { header: "Mobile!\n(10 digits)", get: (d) => d.mobile },
  { header: "Phone!\n(10 digits)", get: (d) => d.phone },
  { header: "Date of Birth\n(YYYY-MM-DD)", get: (d) => d.dob },
  { header: "Language!", get: (d) => d.language },
  { header: "Requested Amount!\n(Currency)", get: (d) => d.requestedAmount },
  { header: "Annual Revenue!\n(Currency)", get: (d) => d.annualRevenue },
  { header: "Estimated Monthly Sales!\n(Currency)", get: (d) => d.monthlySales },
  { header: "Street", get: (d) => d.street },
  { header: "City", get: (d) => d.city },
  { header: "Province!", get: (d) => d.province },
  { header: "Country!", get: (d) => d.country },
  { header: "Postal Code!", get: (d) => d.postalCode },
  { header: "Years in Business!\n(Integer)", get: (d) => d.yearsInBusiness },
  { header: "Entity Type!", get: (d) => d.entityType },
  { header: "Industry!", get: (d) => d.industry },
  { header: "Use of Funds", get: (d) => d.useOfFunds },
];

export function buildSheetRow(data: SheetRowData): { headers: string[]; values: string[] } {
  return {
    headers: MERCHANT_GROWTH_COLUMNS.map((c) => c.header),
    values: MERCHANT_GROWTH_COLUMNS.map((c) => c.get(data)),
  };
}
