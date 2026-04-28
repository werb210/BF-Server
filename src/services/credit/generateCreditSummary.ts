// BF_CREDIT_SUMMARY_v45 — V1 step 7. Real engine producing all 6 spec sections
// from application data + applications.metadata + document signals. Banking
// analysis section is best-effort (depends on OCR field extraction landing
// real transaction data; in V1 we surface known signals + counts and leave
// detailed metrics to V2).
//
// PURE buildSectionsFromInputs() takes a GenerationInputs object so it can be
// unit-tested without a database. The async generateCreditSummary() fetches
// inputs from the DB and delegates.
//
// 6 sections (per project-knowledge screenshot + spec):
//   1. application_overview
//   2. transaction
//   3. business_overview
//   4. financial_overview      (narrative + numeric table)
//   5. banking_analysis        (narrative + metrics)
//   6. recommendation          (narrative + recommended_action)
import { runQuery } from "../../lib/db.js";

export interface ApplicationOverview {
  applicant_name: string | null;
  address: string | null;
  principals: string[];
  assets: string | null;
  transaction_type: string | null;
  loan_amount: number | null;
  term: string | null;
  industry: string | null;
  structure: string | null;
  owner: string | null;
  advance: number | null;
  ltv: number | null;
  website: string | null;
}

export interface FinancialTable {
  headers: string[];
  rows: { label: string; values: (number | null)[] }[];
}

export interface BankingMetrics {
  avg_balance: number | null;
  nsf_count: number | null;
  monthly_revenue: number | null;
  revenue_trend: "up" | "down" | null;
  documents_analyzed: number;
}

export type RecommendedAction = "approve" | "decline" | "needs_more_info" | "review";

export interface CreditSummarySections {
  application_overview: ApplicationOverview;
  transaction: { narrative: string };
  business_overview: { narrative: string };
  financial_overview: { narrative: string; table: FinancialTable };
  banking_analysis: { narrative: string; metrics: BankingMetrics };
  recommendation: { narrative: string; recommended_action: RecommendedAction };
}

export interface GenerationInputs {
  applicationId: string;
  application: {
    name: string | null;
    requested_amount: number | null;
    industry: string | null;
    product_category: string | null;
    product_type: string | null;
    pipeline_state: string | null;
    metadata: Record<string, unknown> | null;
  };
  documentCounts: Record<string, number>;
  bankingMetrics: BankingMetrics | null;
}

const fmtMoney = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "an undisclosed amount";
  return `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
};

const safeStr = (v: unknown): string | null => {
  if (typeof v === "string" && v.trim().length) return v.trim();
  return null;
};

const safeNum = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length) {
    const n = Number(v.replace(/[$,]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
};

const safeArrStr = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  return v.map((x) => safeStr(x)).filter((x): x is string => Boolean(x));
};

function buildApplicationOverview(input: GenerationInputs): ApplicationOverview {
  const md = input.application.metadata ?? {};
  const get = (k: string) => (md as Record<string, unknown>)[k];
  const business = (get("business") ?? get("business_details") ?? {}) as Record<string, unknown>;
  const principals = (get("principals") ?? get("owners") ?? get("applicants") ?? []) as unknown;
  const principalNames = Array.isArray(principals)
    ? principals
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && typeof p === "object") {
            const obj = p as Record<string, unknown>;
            const first = safeStr(obj.first_name ?? obj.firstName);
            const last = safeStr(obj.last_name ?? obj.lastName);
            return [first, last].filter(Boolean).join(" ") || safeStr(obj.name);
          }
          return null;
        })
        .filter((x): x is string => Boolean(x))
    : safeArrStr(principals);

  const addressParts = [
    safeStr(get("address_line1") ?? (business as Record<string, unknown>).address_line1),
    safeStr(get("city") ?? (business as Record<string, unknown>).city),
    safeStr(get("province") ?? (business as Record<string, unknown>).province ?? get("state")),
    safeStr(get("postal_code") ?? (business as Record<string, unknown>).postal_code ?? get("zip")),
  ].filter(Boolean);
  const address = addressParts.length ? addressParts.join(", ") : null;

  const loanAmount = safeNum(input.application.requested_amount) ?? safeNum(get("loan_amount"));
  const collateralValue = safeNum(get("collateral_value")) ?? safeNum(get("asset_value"));
  const ltv =
    loanAmount !== null && collateralValue !== null && collateralValue > 0
      ? Math.round((loanAmount / collateralValue) * 1000) / 10
      : null;

  return {
    applicant_name: safeStr(input.application.name) ?? safeStr(get("legal_name") ?? get("business_name")),
    address,
    principals: principalNames,
    assets: safeStr(get("assets")) ?? safeStr(get("collateral_description")),
    transaction_type: safeStr(get("transaction_type")) ?? safeStr(input.application.product_type),
    loan_amount: loanAmount,
    term: safeStr(get("term")) ?? safeStr(get("term_months")),
    industry: safeStr(input.application.industry) ?? safeStr(get("industry")),
    structure: safeStr(get("structure")) ?? safeStr(get("loan_structure")),
    owner: safeStr(get("owner")) ?? (principalNames[0] ?? null),
    advance: loanAmount,
    ltv,
    website: safeStr(get("website")) ?? safeStr(get("url")),
  };
}

function buildTransactionNarrative(ov: ApplicationOverview, input: GenerationInputs): string {
  const name = ov.applicant_name ?? "The applicant";
  const amount = fmtMoney(ov.loan_amount);
  const purpose =
    safeStr((input.application.metadata as Record<string, unknown>)?.use_of_funds) ??
    safeStr(input.application.product_category) ??
    "general business purposes";
  const term = ov.term ? ` Term requested: ${ov.term}.` : "";
  return `${name} is seeking ${amount} for ${purpose}.${term}`;
}

function buildBusinessNarrative(ov: ApplicationOverview, input: GenerationInputs): string {
  const md = (input.application.metadata ?? {}) as Record<string, unknown>;
  const name = ov.applicant_name ?? "The business";
  const industry = ov.industry ?? "an undisclosed industry";
  const location = ov.address ? ` based in ${ov.address}` : "";
  const founded = safeStr(md.formation_date ?? md.founded ?? md.year_established);
  const foundedClause = founded ? ` The business was established in ${founded}.` : "";
  const principalsClause = ov.principals.length
    ? ` Principal${ov.principals.length > 1 ? "s" : ""}: ${ov.principals.join(", ")}.`
    : "";
  return `${name} operates in ${industry}${location}.${foundedClause}${principalsClause}`;
}

function buildFinancialOverview(input: GenerationInputs): { narrative: string; table: FinancialTable } {
  const md = (input.application.metadata ?? {}) as Record<string, unknown>;
  const financials = (md.financials ?? md.financial_history ?? null) as
    | { years?: (string | number)[]; rows?: Record<string, unknown>[] }
    | null;

  const headers: string[] = [];
  const rowMap = new Map<string, (number | null)[]>();
  const STD_LABELS = ["Revenue", "EBITDA", "Income", "CPLTD", "Current Assets", "Current Liabilities", "Long term Debt", "Equity"];
  for (const lbl of STD_LABELS) rowMap.set(lbl, []);

  if (financials && Array.isArray(financials.years)) {
    for (const y of financials.years) headers.push(String(y));
    if (Array.isArray(financials.rows)) {
      for (const r of financials.rows) {
        const label = safeStr((r as Record<string, unknown>).label);
        if (!label) continue;
        const values: (number | null)[] = [];
        for (const y of headers) {
          const v = (r as Record<string, unknown>)[y];
          values.push(safeNum(v));
        }
        rowMap.set(label, values);
      }
    }
  }

  const tableRows = Array.from(rowMap.entries())
    .filter(([, vals]) => vals.some((v) => v !== null))
    .map(([label, values]) => ({ label, values }));

  const latestRevenue =
    rowMap.get("Revenue")?.find((v): v is number => typeof v === "number") ?? null;
  const narrative = latestRevenue !== null
    ? `Most recent reported revenue: ${fmtMoney(latestRevenue)}. Multi-year financial trends are presented in the table below.`
    : `Financial data has not been fully extracted yet. Submitted documents will populate this section.`;

  return { narrative, table: { headers, rows: tableRows } };
}

function buildBankingAnalysis(input: GenerationInputs): { narrative: string; metrics: BankingMetrics } {
  const m = input.bankingMetrics ?? {
    avg_balance: null, nsf_count: null, monthly_revenue: null,
    revenue_trend: null, documents_analyzed: 0,
  };
  const bankCount = input.documentCounts["Bank Statements"] ?? input.documentCounts["bank_statements"] ?? 0;

  let narrative: string;
  if (m.documents_analyzed > 0 && (m.avg_balance !== null || m.monthly_revenue !== null)) {
    const trend = m.revenue_trend === "up" ? "improving" : m.revenue_trend === "down" ? "declining" : "stable";
    narrative =
      `Banking analysis covers ${m.documents_analyzed} statement(s). ` +
      `Average balance: ${fmtMoney(m.avg_balance)}. Monthly revenue: ${fmtMoney(m.monthly_revenue)}. ` +
      `NSF events: ${m.nsf_count ?? 0}. Revenue trend appears ${trend}.`;
  } else if (bankCount > 0) {
    narrative =
      `${bankCount} bank statement document(s) on file; analysis pending OCR field extraction.`;
  } else {
    narrative = `No bank statements on file yet — request from applicant.`;
  }

  return { narrative, metrics: m };
}

function buildRecommendation(input: GenerationInputs, ov: ApplicationOverview, banking: BankingMetrics): { narrative: string; recommended_action: RecommendedAction } {
  const totalDocs = Object.values(input.documentCounts).reduce((a, b) => a + b, 0);
  let action: RecommendedAction = "review";
  const reasons: string[] = [];

  if (totalDocs === 0) {
    action = "needs_more_info";
    reasons.push("no documents uploaded yet");
  } else if (banking.nsf_count !== null && banking.nsf_count >= 3) {
    action = "review";
    reasons.push(`${banking.nsf_count} NSF events detected — review cash-flow stability`);
  } else if (
    ov.loan_amount !== null && banking.monthly_revenue !== null &&
    banking.monthly_revenue > 0 && ov.loan_amount > banking.monthly_revenue * 24
  ) {
    action = "review";
    reasons.push("requested amount is more than 24 months of revenue — verify capacity");
  }

  const narrative = reasons.length
    ? `Recommend ${action.replace(/_/g, " ")}: ${reasons.join("; ")}.`
    : `Application meets initial underwriting screen. Recommend continuing to lender match.`;

  return { narrative, recommended_action: action };
}

export function buildSectionsFromInputs(input: GenerationInputs): CreditSummarySections {
  const application_overview = buildApplicationOverview(input);
  const transaction = { narrative: buildTransactionNarrative(application_overview, input) };
  const business_overview = { narrative: buildBusinessNarrative(application_overview, input) };
  const financial_overview = buildFinancialOverview(input);
  const banking_analysis = buildBankingAnalysis(input);
  const recommendation = buildRecommendation(input, application_overview, banking_analysis.metrics);
  return {
    application_overview,
    transaction,
    business_overview,
    financial_overview,
    banking_analysis,
    recommendation,
  };
}

interface AppRow {
  id: string;
  name: string | null;
  requested_amount: string | number | null;
  industry: string | null;
  product_category: string | null;
  product_type: string | null;
  pipeline_state: string | null;
  metadata: Record<string, unknown> | null;
}

interface DocCountRow { category: string | null; cnt: string }

export async function loadGenerationInputs(applicationId: string): Promise<GenerationInputs> {
  const appRes = await runQuery<AppRow>(
    `SELECT id,
            name,
            requested_amount,
            COALESCE(metadata->>'industry', NULL) AS industry,
            product_category,
            product_type,
            pipeline_state,
            metadata
       FROM applications
      WHERE id::text = ($1)::text
      LIMIT 1`,
    [applicationId]
  );
  const app = appRes.rows[0];
  if (!app) {
    throw Object.assign(new Error("application_not_found"), { status: 404 });
  }

  // BF_CREDIT_SCHEMA_FIX_v52 — `documents` has no `category` column.
  // Real columns: signed_category (nullable, staff-assigned) and
  // document_type (NOT NULL DEFAULT 'general'). Prefer the staff-assigned
  // category, fall back to the upload-time type, then 'unknown'.
  const docRes = await runQuery<DocCountRow>(
    `SELECT COALESCE(signed_category, document_type, 'unknown') AS category,
            COUNT(*)::text AS cnt
       FROM documents
      WHERE application_id::text = ($1)::text
      GROUP BY 1`,
    [applicationId]
  );
  const documentCounts: Record<string, number> = {};
  for (const row of docRes.rows) {
    documentCounts[row.category ?? "unknown"] = Number(row.cnt) || 0;
  }

  // Best-effort: count completed banking analyses for this application.
  let bankingMetrics: BankingMetrics | null = null;
  try {
    const bankRes = await runQuery<{ analyzed: string }>(
      `SELECT COUNT(*)::text AS analyzed
         FROM documents
        WHERE application_id::text = ($1)::text
          AND banking_status = 'completed'`,
      [applicationId]
    );
    const analyzed = Number(bankRes.rows[0]?.analyzed ?? 0);
    bankingMetrics = {
      avg_balance: null,
      nsf_count: null,
      monthly_revenue: null,
      revenue_trend: null,
      documents_analyzed: analyzed,
    };
  } catch {
    bankingMetrics = null;
  }

  return {
    applicationId,
    application: {
      name: app.name,
      requested_amount: app.requested_amount === null ? null : Number(app.requested_amount) || null,
      industry: app.industry ?? null,
      product_category: app.product_category,
      product_type: app.product_type,
      pipeline_state: app.pipeline_state,
      metadata: app.metadata ?? {},
    },
    documentCounts,
    bankingMetrics,
  };
}

export async function generateCreditSummary(applicationId: string): Promise<{
  sections: CreditSummarySections;
  inputs: GenerationInputs;
}> {
  const inputs = await loadGenerationInputs(applicationId);
  const sections = buildSectionsFromInputs(inputs);
  return { sections, inputs };
}
