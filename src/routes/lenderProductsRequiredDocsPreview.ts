// BF_SERVER_BLOCK_v128_REQUIRED_DOCS_PREVIEW_v1
// Diagnostic endpoint that runs the same query the wizard's Step 5 uses,
// for an arbitrary set of legs, and returns the union of required
// document_types per leg + across legs. Built for verifying that the
// server-first required-docs path matches the wizard's expected output
// without having to walk through the wizard manually.
//
// Mounted at /api/portal/lender-products/required-docs/preview.
//
// Two routes:
//   POST .../preview          — body: { country, legs: [{category, amount}] }
//   GET  .../preview/six-traces — runs the 6 baseline traces from the
//                                 May trace report. Returns a structured
//                                 report with warnings.
//
// Auth: same as the rest of /portal — requires staff session (the
// existing /required-docs route is unauthenticated because the public
// wizard hits it; this preview is for staff only).

import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/errors.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js"; // BF_SERVER_SILENT_QUERIES_v678

function normalizeProductCategoryForFilter(value: string): string {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw) return "";
  const map: Record<string, string> = {
    LINE_OF_CREDIT: "LOC",
    STANDARD: "LOC",
    TERM_LOAN: "TERM",
    PURCHASE_ORDER: "PO",
    PURCHASE_ORDER_FINANCE: "PO",
    EQUIPMENT_FINANCE: "EQUIPMENT",
    EQUIPMENT_FINANCING: "EQUIPMENT",
    MERCHANT_CASH_ADVANCE: "MCA",
    MEDIA_FUNDING: "MEDIA",
    ASSET_BASED_LENDING: "ABL",
    SBA_GOVERNMENT: "SBA",
    STARTUP_CAPITAL: "STARTUP",
  };
  return map[raw] ?? raw;
}

const GLOBAL_ALWAYS_REQUIRED = ["bank_statements", "photo_id"];

type LegInput = { category: string; amount: number };
type DocEntry = {
  document_type: string;
  required: boolean;
  min_amount: number | null;
  max_amount: number | null;
};
type ProductRow = {
  id: string;
  lender_name: string;
  product_name: string;
  category_short: string;
  country: string;
  amount_min: number | null;
  amount_max: number | null;
  required_documents: any;
};

async function probeLenderProductsColumns(): Promise<Set<string>> {
  const r = await pool
    .query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'lender_products'`,
    )
    .catch((swallowedErr: unknown) => logWarnSwallowed(swallowedErr, "routes/lenderProductsRequiredDocsPreview.ts:67", ({ rows: [] as Array<{ column_name: string }> })));
  return new Set(r.rows.map((row) => row.column_name));
}

async function queryProductsForLeg(country: string | null, leg: LegInput, cols: Set<string>): Promise<ProductRow[]> {
  if (!cols.has("required_documents")) return [];
  const where: string[] = [];
  const params: unknown[] = [];

  if (cols.has("active")) where.push("lp.active IS TRUE");
  if (cols.has("status")) where.push("(lp.status IS NULL OR lp.status = 'active')");
  if (country && cols.has("country")) {
    params.push(country.toUpperCase());
    where.push(`(lp.country IS NULL OR upper(lp.country) = $${params.length} OR upper(lp.country) = 'BOTH')`);
  }

  const normalizedCategory = normalizeProductCategoryForFilter(leg.category);
  if (normalizedCategory && cols.has("category")) {
    params.push(normalizedCategory.toLowerCase());
    where.push(`(lp.category IS NULL OR lower(lp.category) = $${params.length})`);
  }

  if (leg.amount !== null && leg.amount !== undefined) {
    const minCol = cols.has("amount_min") ? "amount_min" : cols.has("min_amount") ? "min_amount" : null;
    const maxCol = cols.has("amount_max") ? "amount_max" : cols.has("max_amount") ? "max_amount" : null;
    if (minCol) {
      params.push(leg.amount);
      where.push(`(lp.${minCol} IS NULL OR lp.${minCol} <= $${params.length})`);
    }
    if (maxCol) {
      params.push(leg.amount);
      where.push(`(lp.${maxCol} IS NULL OR lp.${maxCol} >= $${params.length})`);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const minColAlias = cols.has("amount_min") ? "amount_min" : cols.has("min_amount") ? "min_amount" : null;
  const maxColAlias = cols.has("amount_max") ? "amount_max" : cols.has("max_amount") ? "max_amount" : null;
  const countryColAlias = cols.has("country") ? "lp.country" : "NULL::text";
  const categoryColAlias = cols.has("category") ? "lp.category" : "NULL::text";

  const sql = `SELECT lp.id::text AS id,
            COALESCE(l.name, '<unknown>') AS lender_name,
            lp.name AS product_name,
            UPPER(${categoryColAlias}) AS category_short,
            UPPER(COALESCE(${countryColAlias}, 'BOTH')) AS country,
            ${minColAlias ? `lp.${minColAlias}` : "NULL::bigint"} AS amount_min,
            ${maxColAlias ? `lp.${maxColAlias}` : "NULL::bigint"} AS amount_max,
            lp.required_documents
       FROM lender_products lp
       LEFT JOIN lenders l ON l.id = lp.lender_id
       ${whereSql}
       ORDER BY category_short, lender_name, product_name`;

  try {
    const r = await pool.query<ProductRow>(sql, params);
    return r.rows;
  } catch {
    return [];
  }
}

function extractDocsFromProduct(row: ProductRow): DocEntry[] {
  const arr = row.required_documents;
  const out: DocEntry[] = [];
  if (Array.isArray(arr)) {
    for (const item of arr) {
      if (typeof item === "string" && item.trim()) {
        out.push({ document_type: item.trim(), required: true, min_amount: null, max_amount: null });
      } else if (item && typeof item === "object") {
        const docType =
          typeof item.document_type === "string" && item.document_type.trim()
            ? item.document_type.trim()
            : typeof item.category === "string" && item.category.trim()
              ? item.category.trim()
              : null;
        if (docType) {
          out.push({
            document_type: docType,
            required: item.required !== false,
            min_amount: typeof item.min_amount === "number" ? item.min_amount : null,
            max_amount: typeof item.max_amount === "number" ? item.max_amount : null,
          });
        }
      }
    }
  } else if (arr && typeof arr === "object") {
    for (const [k, v] of Object.entries(arr as Record<string, unknown>)) {
      if (k && v) out.push({ document_type: k, required: Boolean(v), min_amount: null, max_amount: null });
    }
  }
  return out;
}

type LegReport = {
  category: string;
  normalizedCategory: string;
  amount: number;
  matchingProducts: Array<{id: string; lender_name: string; product_name: string; category_short: string; country: string; amount_min: number | null; amount_max: number | null; docCount: number;}>;
  requiredDocs: Array<{ document_type: string; required: boolean; fromProducts: string[] }>;
};

async function runOneLeg(country: string | null, leg: LegInput, cols: Set<string>): Promise<LegReport> {
  const rows = await queryProductsForLeg(country, leg, cols);
  const docMap = new Map<string, { required: boolean; fromProducts: string[] }>();
  for (const row of rows) {
    const docs = extractDocsFromProduct(row);
    for (const d of docs) {
      const existing = docMap.get(d.document_type);
      if (existing) {
        existing.required = existing.required || d.required;
        if (!existing.fromProducts.includes(row.product_name)) existing.fromProducts.push(row.product_name);
      } else {
        docMap.set(d.document_type, { required: d.required, fromProducts: [row.product_name] });
      }
    }
  }
  return {
    category: leg.category,
    normalizedCategory: normalizeProductCategoryForFilter(leg.category),
    amount: leg.amount,
    matchingProducts: rows.map((row) => ({ ...row, docCount: extractDocsFromProduct(row).length })),
    requiredDocs: Array.from(docMap.entries()).map(([document_type, v]) => ({ document_type, required: v.required, fromProducts: v.fromProducts.sort() })).sort((a, b) => a.document_type.localeCompare(b.document_type)),
  };
}

function buildUnion(legs: LegReport[]): Array<{document_type: string; required: boolean; fromLegs: string[]}> {
  const map = new Map<string, { required: boolean; fromLegs: string[] }>();
  for (const leg of legs) {
    const tag = `${leg.normalizedCategory}:${leg.amount}`;
    for (const d of leg.requiredDocs) {
      const existing = map.get(d.document_type);
      if (existing) {
        existing.required = existing.required || d.required;
        if (!existing.fromLegs.includes(tag)) existing.fromLegs.push(tag);
      } else map.set(d.document_type, { required: d.required, fromLegs: [tag] });
    }
  }
  return Array.from(map.entries()).map(([document_type, v]) => ({ document_type, required: v.required, fromLegs: v.fromLegs })).sort((a, b) => a.document_type.localeCompare(b.document_type));
}

const router = Router();
router.post("/lender-products/required-docs/preview", requireAuth, safeHandler(async (req: Request, res: Response) => {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, any>) : {};
  const country = typeof body.country === "string" && body.country.trim() ? body.country.trim().toUpperCase() : null;
  const legsInput = Array.isArray(body.legs) ? body.legs : [];
  if (legsInput.length === 0) throw new AppError("validation_error", "At least one leg is required.", 400);
  const legs: LegInput[] = legsInput.map((leg: any) => ({ category: String(leg?.category ?? "").trim(), amount: Number(leg?.amount ?? 0) })).filter((leg: LegInput) => leg.category && Number.isFinite(leg.amount) && leg.amount > 0);
  if (legs.length === 0) throw new AppError("validation_error", "All legs must have category and positive amount.", 400);
  const cols = await probeLenderProductsColumns();
  const legReports = await Promise.all(legs.map((leg) => runOneLeg(country, leg, cols)));
  const union = buildUnion(legReports);
  const finalUnion = Array.from(new Set([...union.map((u) => u.document_type), ...GLOBAL_ALWAYS_REQUIRED])).sort();
  res.json({ country, legs: legReports, union, globalAlwaysRequired: GLOBAL_ALWAYS_REQUIRED, finalUnion });
}));

const SIX_TRACES = [
  { name: "trace_1_capital_term_200k", description: "Capital, TERM, $200,000, Canada", country: "CA", legs: [{ category: "TERM_LOAN", amount: 200000 }], predictedDocCountRange: [2, 12] as [number, number] },
  { name: "trace_2_capital_loc_1m", description: "Capital, LOC, $1,000,000, Canada", country: "CA", legs: [{ category: "LINE_OF_CREDIT", amount: 1000000 }], predictedDocCountRange: [2, 12] as [number, number] },
  { name: "trace_3_capital_term_40k", description: "Capital, TERM, $40,000, Canada", country: "CA", legs: [{ category: "TERM_LOAN", amount: 40000 }], predictedDocCountRange: [2, 12] as [number, number] },
  { name: "trace_4_equipment_280k", description: "Equipment, $280,000, Canada (no closing costs)", country: "CA", legs: [{ category: "EQUIPMENT_FINANCE", amount: 280000 }], predictedDocCountRange: [2, 12] as [number, number] },
  { name: "trace_5_equipment_600k_with_closing", description: "Equipment $600,000 + closing-costs companion (LOC $120,000), Canada", country: "CA", legs: [{ category: "EQUIPMENT_FINANCE", amount: 600000 }, { category: "LINE_OF_CREDIT", amount: 120000 }], predictedDocCountRange: [2, 16] as [number, number] },
  { name: "trace_6_capital_and_equipment_400k_240k_loc", description: "C&E, capital LOC $400,000 + equipment $240,000, Canada", country: "CA", legs: [{ category: "LINE_OF_CREDIT", amount: 400000 }, { category: "EQUIPMENT_FINANCE", amount: 240000 }], predictedDocCountRange: [2, 16] as [number, number] },
];

// BF_SERVER_BLOCK_v128_1_PUBLIC_SIX_TRACES_v1
// requireAuth removed from this GET route. The endpoint runs 6
// hardcoded traces and returns lender_name / product_name /
// amount_min / amount_max / required_documents — same data already
// exposed by the public /api/portal/lender-products route used by
// the unauthenticated wizard. No new information is exposed; this
// is purely a convenience for browser-direct inspection.
// The POST .../preview route stays authed because it accepts
// arbitrary leg input.
router.get("/lender-products/required-docs/preview/six-traces", safeHandler(async (_req: Request, res: Response) => {
  const cols = await probeLenderProductsColumns();
  const out: Array<Record<string, unknown>> = [];
  for (const trace of SIX_TRACES) {
    const legReports = await Promise.all(trace.legs.map((leg) => runOneLeg(trace.country, leg, cols)));
    const union = buildUnion(legReports);
    const finalUnion = Array.from(new Set([...union.map((u) => u.document_type), ...GLOBAL_ALWAYS_REQUIRED])).sort();
    const totalProducts = legReports.reduce((acc, lr) => acc + lr.matchingProducts.length, 0);
    const predictedOk = finalUnion.length >= trace.predictedDocCountRange[0] && finalUnion.length <= trace.predictedDocCountRange[1];
    out.push({
      ...trace,
      legs: legReports,
      union,
      globalAlwaysRequired: GLOBAL_ALWAYS_REQUIRED,
      finalUnion,
      finalUnionCount: finalUnion.length,
      totalMatchingProducts: totalProducts,
      predictedOk,
      warnings: [
        ...(totalProducts === 0 ? ["No matching products for any leg — Step 2 would be empty for this combination."] : []),
        ...legReports.filter((lr) => lr.matchingProducts.length === 0).map((lr) => `Leg ${lr.normalizedCategory}@${lr.amount}: zero matching products.`),
        ...(!predictedOk ? [`Final union doc count (${finalUnion.length}) is outside predicted range ${trace.predictedDocCountRange[0]}-${trace.predictedDocCountRange[1]}.`] : []),
      ],
    });
  }
  res.json({ generatedAt: new Date().toISOString(), traces: out });
}));

export default router;
