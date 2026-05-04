// BF_SERVER_BLOCK_v109_REQUIRED_DOCS_ROUTE_v1
// GET /lender-products/required-docs — returns the deduped union of
// required_documents from every active lender_products row whose match
// filters allow the borrower's Step 1+2 inputs.
//
// Mounted on combinedPortalRoutes in routeRegistry.ts → final path is
//   GET /api/portal/lender-products/required-docs
//
// Response shape:
//   { items: LenderProductRequirement[] }
//   where LenderProductRequirement =
//     { id, document_type, required, min_amount?, max_amount? }
//
// This MUST match BF-client's wizard/requirements.ts type so that
// getMissingRequiredDocs() can correctly filter on .required and read
// .document_type. Returning plain strings here would silently break the
// wizard's submit gate.

import { Router } from "express";
import { pool } from "../db.js";

// BF_SERVER_BLOCK_v115_REQUIRED_DOCS_CATEGORY_NORMALIZE_v1
// The wizard sends long-form category codes (TERM_LOAN, LINE_OF_CREDIT,
// EQUIPMENT_FINANCING, ...) but lender_products.category stores the short
// codes (TERM, LOC, EQUIPMENT, ...) per the CHECK constraint added in
// migration 041_lender_schema_enforcement.sql. Same map is in
// portalLenderProducts.ts:normalizeProductCategory — duplicating here so
// this route is self-contained.
function normalizeProductCategoryForFilter(value: string): string {
  const raw = value.trim().toUpperCase();
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

const router = Router();

router.get("/lender-products/required-docs", async (req, res) => {
  const country         = String(req.query.country ?? "").toUpperCase().slice(0, 2);
  // BF_SERVER_BLOCK_v115_REQUIRED_DOCS_CATEGORY_NORMALIZE_v1 — normalize to
  // the short-code vocabulary used by the DB column before lowercasing.
  const product_category = normalizeProductCategoryForFilter(
    String(req.query.product_category ?? "")
  ).toLowerCase();
  const funding_amount  = Number(req.query.funding_amount ?? 0) || null;
  const industry        = String(req.query.industry ?? "").toLowerCase();
  const revenue_last_12 = Number(req.query.revenue_last_12 ?? 0) || null;
  const years_in_business = Number(req.query.years_in_business ?? 0) || null;

  // Probe live columns to stay tolerant of schema variants
  const colsRes = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'lender_products'`
  ).catch(() => ({ rows: [] as Array<{ column_name: string }> }));
  const cols = new Set(colsRes.rows.map((r) => r.column_name));

  if (!cols.has("required_documents")) {
    return res.status(200).json({ items: [] });
  }

  const where: string[] = [];
  const params: unknown[] = [];
  if (cols.has("active")) where.push("active IS TRUE");
  if (cols.has("status")) where.push("(status IS NULL OR status = 'active')");
  if (country && cols.has("country")) {
    params.push(country);
    where.push(`(country IS NULL OR upper(country) = $${params.length})`);
  }
  if (product_category && cols.has("category")) {
    params.push(product_category);
    where.push(`(category IS NULL OR lower(category) = $${params.length})`);
  }
  if (funding_amount !== null) {
    if (cols.has("min_amount")) {
      params.push(funding_amount);
      where.push(`(min_amount IS NULL OR min_amount <= $${params.length})`);
    }
    if (cols.has("max_amount")) {
      params.push(funding_amount);
      where.push(`(max_amount IS NULL OR max_amount >= $${params.length})`);
    }
  }
  if (industry && cols.has("industries")) {
    params.push(industry);
    where.push(`(industries IS NULL OR (industries::text ILIKE '%' || $${params.length} || '%'))`);
  }
  if (years_in_business !== null && cols.has("min_years_in_business")) {
    params.push(years_in_business);
    where.push(`(min_years_in_business IS NULL OR min_years_in_business <= $${params.length})`);
  }
  if (revenue_last_12 !== null && cols.has("min_revenue")) {
    params.push(revenue_last_12);
    where.push(`(min_revenue IS NULL OR min_revenue <= $${params.length})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT id, required_documents FROM lender_products ${whereSql}`;

  let rows: Array<{ id: string; required_documents: any }> = [];
  try { ({ rows } = await pool.query(sql, params)); }
  catch { return res.status(200).json({ items: [] }); }

  // Union by document_type. OR the `required` flag across products. Take
  // tightest min/max amount window.
  type Entry = { id: string; document_type: string; required: boolean; min_amount: number | null; max_amount: number | null };
  const map = new Map<string, Entry>();
  for (const row of rows) {
    const arr = row.required_documents;
    const entries: Array<Partial<Entry> & { document_type: string }> = [];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === "string" && item.trim()) {
          entries.push({ document_type: item.trim(), required: true });
        } else if (item && typeof item === "object") {
          // BF_SERVER_BLOCK_v117_REQUIRED_DOCS_FIELD_NAME_FIX_v1
          // The Edit Product modal in BF-portal saves required_documents
          // entries with the field name `category`. Older code paths used
          // `document_type`. Accept either as the source — emit canonical
          // `document_type` in the response so the BF-client fetcher
          // (BF_CLIENT_BLOCK_v107) can read it unchanged.
          const docType =
            typeof item.document_type === "string" && item.document_type.trim()
              ? item.document_type.trim()
              : typeof item.category === "string" && item.category.trim()
              ? item.category.trim()
              : null;
          if (docType) {
            entries.push({
              document_type: docType,
              required: item.required !== false,
              min_amount: item.min_amount ?? null,
              max_amount: item.max_amount ?? null,
            });
          }
        }
      }
    } else if (arr && typeof arr === "object") {
      for (const [k, v] of Object.entries(arr)) {
        if (k && v) entries.push({ document_type: k, required: Boolean(v) });
      }
    }
    for (const e of entries) {
      const prev = map.get(e.document_type);
      if (!prev) {
        map.set(e.document_type, {
          id: `req:${e.document_type}`,
          document_type: e.document_type,
          required: Boolean(e.required ?? true),
          min_amount: e.min_amount ?? null,
          max_amount: e.max_amount ?? null,
        });
      } else {
        prev.required = prev.required || Boolean(e.required ?? true);
      }
    }
  }

  res.status(200).json({
    items: Array.from(map.values()).sort((a, b) =>
      a.document_type.localeCompare(b.document_type)
    ),
  });
});

export default router;
