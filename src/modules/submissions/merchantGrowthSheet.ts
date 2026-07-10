// BF_SERVER_GSHEET_ROW_v1
// Loads a submitted application's real fields and maps them into an ordered row
// that matches the lender's Google Sheet template. Merchant Growth ingests the
// sheet into Salesforce via G-Connector, which maps by COLUMN ORDER/HEADER - so
// COLUMNS below must match their template exactly (edit the order/labels to match
// the shared sheet). Everything is best-effort/defensive; a missing field becomes
// an empty cell rather than throwing.
import type { Pool } from "pg";

export type SheetRowData = {
  applicationId: string;
  businessName: string;
  contactName: string;
  email: string;
  phone: string;
  requestedAmount: string;
  productCategory: string;
  productType: string;
  annualRevenue: string;
  monthlyRevenue: string;
  timeInBusiness: string;
  province: string;
  submittedAt: string;
};

function s(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return String(v).trim();
}

// Pull a value out of the application metadata JSON by any of several likely keys.
function metaPick(meta: Record<string, unknown> | null, keys: string[]): string {
  if (!meta) return "";
  const core = (meta.core_inputs && typeof meta.core_inputs === "object" ? meta.core_inputs : {}) as Record<string, unknown>;
  for (const k of keys) {
    if (meta[k] !== undefined && meta[k] !== null && meta[k] !== "") return s(meta[k]);
    if (core[k] !== undefined && core[k] !== null && core[k] !== "") return s(core[k]);
  }
  return "";
}

export async function loadSheetRowData(pool: Pool, applicationId: string): Promise<SheetRowData> {
  const r = await pool
    .query<{
      application_id: string;
      business_name: string | null;
      requested_amount: string | number | null;
      product_category: string | null;
      product_type: string | null;
      metadata: unknown;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      phone: string | null;
      company_name: string | null;
    }>(
      `SELECT a.id::text AS application_id,
              a.name AS business_name,
              a.requested_amount,
              a.product_category,
              a.product_type,
              a.metadata,
              c.first_name, c.last_name, c.email, c.phone, c.company_name
         FROM applications a
         LEFT JOIN contacts c ON c.id = a.contact_id
        WHERE a.id::text = $1
        LIMIT 1`,
      [applicationId],
    )
    .catch(() => ({ rows: [] as never[] }));

  const row = Array.isArray(r.rows) ? r.rows[0] : undefined;
  const meta = (row?.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>;
  const contactName = [s(row?.first_name), s(row?.last_name)].filter(Boolean).join(" ");

  return {
    applicationId,
    businessName: s(row?.business_name) || s(row?.company_name),
    contactName,
    email: s(row?.email),
    phone: s(row?.phone),
    requestedAmount: s(row?.requested_amount),
    productCategory: s(row?.product_category),
    productType: s(row?.product_type),
    annualRevenue: metaPick(meta, ["annual_revenue", "annualRevenue"]),
    monthlyRevenue: metaPick(meta, ["monthly_revenue", "monthlyRevenue", "average_monthly_revenue"]),
    timeInBusiness: metaPick(meta, ["time_in_business", "timeInBusiness", "years_in_business", "months_in_business"]),
    province: metaPick(meta, ["province", "state", "business_province"]),
    submittedAt: new Date().toISOString(),
  };
}

// EDIT THIS to match Merchant Growth's template header row, left-to-right.
// header = the column header text; get = how to fill the cell from the loaded data.
// The ORDER of this array IS the column order written to the sheet.
export const MERCHANT_GROWTH_COLUMNS: { header: string; get: (d: SheetRowData) => string }[] = [
  { header: "Submitted At", get: (d) => d.submittedAt },
  { header: "Business Legal Name", get: (d) => d.businessName },
  { header: "Contact Name", get: (d) => d.contactName },
  { header: "Email", get: (d) => d.email },
  { header: "Phone", get: (d) => d.phone },
  { header: "Requested Amount", get: (d) => d.requestedAmount },
  { header: "Product Category", get: (d) => d.productCategory },
  { header: "Time in Business", get: (d) => d.timeInBusiness },
  { header: "Monthly Revenue", get: (d) => d.monthlyRevenue },
  { header: "Province", get: (d) => d.province },
  { header: "Application ID", get: (d) => d.applicationId },
];

export function buildSheetRow(data: SheetRowData): { headers: string[]; values: string[] } {
  return {
    headers: MERCHANT_GROWTH_COLUMNS.map((c) => c.header),
    values: MERCHANT_GROWTH_COLUMNS.map((c) => c.get(data)),
  };
}
