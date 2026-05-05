/**
 * Portal lender-products CRUD routes.
 * Mounted at /api/portal by routeRegistry — all paths are relative to that prefix.
 */
import { Router } from "express";
import { pool, runQuery } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { AppError } from "../middleware/errors.js";
import { getSilo } from "../middleware/silo.js";
import {
  listLenderProducts,
  listLenderProductsByLenderId,
  fetchLenderProductById,
  createLenderProduct,
  updateLenderProduct,
} from "../repositories/lenderProducts.repo.js";

// BF_SERVER_BLOCK_v130_REQUIRED_DOCS_FORM_GUARD_v1
// Authoritative whitelist of doc category labels the portal's lender-product
// React form (BF-portal/src/pages/lenders/LendersPage.tsx) can produce. Any
// payload containing a category outside this list, or with extra keys
// beyond {category, required, description}, is rejected at the API boundary.
// This stops legacy seeds, manual SQL, and bypass scripts from reintroducing
// the snake_case duplicates / orphan slugs that v131 (data cleanup) just fixed.
//
// To add a new doc type: edit BOTH this list AND the React form's
// coreTypes/conditionalTypes/alwaysRequiredDoc arrays. Keeping the
// portal form and server in sync is enforced by this guard — there is no
// way to save an unrecognized doc through any code path that hits the API.
const PORTAL_FORM_DOC_LABELS: ReadonlySet<string> = new Set([
  // alwaysRequiredDoc + equipmentFinanceAlwaysRequiredDoc
  "6 months business banking statements",
  "Purchase Order or Invoice of Equipment to finance",
  // coreTypes (15)
  "3 years accountant prepared financials",
  "3 years business tax returns",
  "PnL – Interim financials",
  "Balance Sheet – Interim financials",
  "A/R",
  "A/P",
  "2 pieces of Government Issued ID",
  "VOID cheque or PAD",
  "Personal net worth statement",
  "2 years personal tax returns (T1 generals)",
  "Corporate structure / org chart",
  "Business plan / projections",
  "Lease agreement (if applicable)",
  "Accounts receivable aging report",
  "Accounts payable aging report",
  // conditionalTypes (Media, 5)
  "Budget",
  "Finance plan",
  "Tax credit status",
  "Production schedule",
  "Minimum guarantees / presales",
]);

const PORTAL_FORM_DOC_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "category",
  "required",
  "description",
  "min_amount",
  "max_amount",
  "document_type",
]);

function validateAndNormalizeRequiredDocuments(input: unknown): {
  normalized: Array<{ category: string; required: boolean; description: string | null }>;
  errors: string[];
} {
  const errors: string[] = [];
  if (input === null || input === undefined) return { normalized: [], errors };
  if (!Array.isArray(input)) {
    errors.push("required_documents must be an array");
    return { normalized: [], errors };
  }
  const normalized: Array<{ category: string; required: boolean; description: string | null }> = [];
  const seenLabels = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`required_documents[${i}] must be an object`);
      continue;
    }
    const obj = item as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (!PORTAL_FORM_DOC_ALLOWED_KEYS.has(k)) {
        errors.push(`required_documents[${i}] has unrecognized key "${k}"`);
      }
    }
    const rawLabel =
      typeof obj.category === "string" && obj.category.trim()
        ? obj.category.trim()
        : typeof obj.document_type === "string" && obj.document_type.trim()
          ? obj.document_type.trim()
          : "";
    if (!rawLabel) {
      errors.push(`required_documents[${i}] missing category`);
      continue;
    }
    if (!PORTAL_FORM_DOC_LABELS.has(rawLabel)) {
      errors.push(
        `required_documents[${i}] category "${rawLabel}" is not in the canonical portal-form list. ` +
        `Update BF-portal/LendersPage.tsx coreTypes/conditionalTypes AND BF-Server portalLenderProducts.ts ` +
        `PORTAL_FORM_DOC_LABELS in lockstep, then redeploy both.`
      );
      continue;
    }
    if (seenLabels.has(rawLabel)) {
      errors.push(`required_documents[${i}] duplicates earlier entry "${rawLabel}"`);
      continue;
    }
    seenLabels.add(rawLabel);
    normalized.push({
      category: rawLabel,
      required: obj.required === false ? false : true,
      description:
        typeof obj.description === "string" && obj.description.trim()
          ? obj.description.trim()
          : null,
    });
  }
  return { normalized, errors };
}

const router = Router();

// BF_LP_FIELDS_v32 — Block 32: accept both client camelCase and server camelCase
// for amount/rate/term, plus persist signnow + eligibility. Return both naming
// conventions on every response so the portal normalizer reads the right keys.
function pickFirst(...vals: unknown[]): unknown {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
}
function asNum(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
// BF_LP_COMMISSION_CREDIT_v36
function bfNum(raw: unknown): number | null {
  return asNum(raw);
}
function asString(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s === "" ? null : s;
}
// BF_SERVER_BLOCK_v88_LENDER_PRODUCT_CATEGORY_NORMALIZE_v1
// The portal dropdown still emits the long-vocabulary codes
// (TERM_LOAN, LINE_OF_CREDIT, EQUIPMENT_FINANCE, etc.) but the
// lender_products.category CHECK constraint requires the short
// codes (TERM, LOC, EQUIPMENT, ...). Translate at the route
// boundary so anything reaching the repo is constraint-compliant.
function normalizeProductCategory(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim().toUpperCase();
  if (!raw) return null;
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
function decorateProductResponse(product: any): any {
  if (!product || typeof product !== "object") return product;
  const row = product;
  const amount_min = product.amount_min ?? null;
  const amount_max = product.amount_max ?? null;
  const interest_min = product.interest_min ?? null;
  const interest_max = product.interest_max ?? null;
  const term_min = product.term_min ?? null;
  const term_max = product.term_max ?? null;
  const term_unit = product.term_unit ?? "MONTHS";
  const signnow_template_id = product.signnow_template_id ?? null;
  const eligibility_notes = product.eligibility_notes ?? null;
  return {
    ...product,
    productName: product.productName ?? product.name ?? null,
    minAmount: amount_min !== null ? Number(amount_min) : 0,
    maxAmount: amount_max !== null ? Number(amount_max) : 0,
    interestRateMin: interest_min !== null ? Number(interest_min) : 0,
    interestRateMax: interest_max !== null ? Number(interest_max) : 0,
    termLength: {
      min: term_min !== null ? Number(term_min) : 0,
      max: term_max !== null ? Number(term_max) : 0,
      unit: typeof term_unit === "string" ? term_unit.toLowerCase() : "months",
    },
    signnowTemplateId: signnow_template_id,
    eligibilityRules: eligibility_notes,
    // BF_LP_COMMISSION_CREDIT_v36
    commission: row.commission != null ? Number(row.commission) : null,
    commissionPercent: row.commission != null ? Number(row.commission) : null,
    minCreditScore: row.min_credit_score != null ? Number(row.min_credit_score) : null,
    min_credit_score: row.min_credit_score != null ? Number(row.min_credit_score) : null,
  };
}


// GET /api/portal/lender-products[?lenderId=...]
// BF_SERVER_BLOCK_v133_PORTAL_LENDER_AUTH_v1 — AUDIT-8
router.get(
  "/lender-products",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const silo = getSilo(res);
    const lenderId =
      typeof req.query.lenderId === "string" ? req.query.lenderId.trim() : "";
    const products = lenderId
      ? await listLenderProductsByLenderId(lenderId, pool)
      : await listLenderProducts(pool);
    const filtered = (products ?? []).filter((p: any) => !p.silo || p.silo === silo);
    res.status(200).json({ items: filtered.map(decorateProductResponse) });
  })
);

// GET /api/portal/lender-products/:id
// BF_SERVER_BLOCK_v133_PORTAL_LENDER_AUTH_v1 — AUDIT-8
router.get(
  "/lender-products/:id",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) throw new AppError("validation_error", "Product id is required.", 400);
    const silo = getSilo(res);
    const product = await fetchLenderProductById(id, pool);
    if (product && product.silo && product.silo !== silo) throw new AppError("not_found", "Lender product not found.", 404);
    if (!product) throw new AppError("not_found", "Lender product not found.", 404);
    res.status(200).json(decorateProductResponse(product));
  })
);

// POST /api/portal/lender-products
router.post(
  "/lender-products",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const body = req.body ?? {};
    const silo = getSilo(res);
    const lenderId =
      typeof body.lenderId === "string"
        ? body.lenderId
        : typeof body.lender_id === "string"
          ? body.lender_id
          : "";

    // BF_SERVER_v67_LENDER_PRODUCT_NAME_FALLBACK — accept body.productName
    // as a fallback so the portal's existing payload shape (which sends
    // productName, not name) is no longer rejected with 400.
    const name =
      typeof body.name === "string" && body.name
        ? body.name
        : typeof body.productName === "string" && body.productName
          ? body.productName
          : "";
    // BF_SERVER_BLOCK_v88_LENDER_PRODUCT_CATEGORY_NORMALIZE_v1
    const category =
      normalizeProductCategory(body.category) ?? "LOC";

    if (!lenderId) throw new AppError("validation_error", "lenderId is required.", 400);
    if (!name) throw new AppError("validation_error", "name is required.", 400);

    const product = await createLenderProduct({
      lenderId,
      name,
      active: body.active ?? true,
      category,
      requiredDocuments: (() => {
        // BF_SERVER_BLOCK_v130_REQUIRED_DOCS_FORM_GUARD_v1
        const raw = body.requiredDocuments ?? body.required_documents ?? [];
        const { normalized, errors } = validateAndNormalizeRequiredDocuments(raw);
        if (errors.length > 0) {
          throw new AppError("validation_error", `required_documents invalid: ${errors.join("; ")}`, 400);
        }
        return normalized;
      })(),
      country: body.country ?? null,
      rateType: (pickFirst(body.rateType, body.rate_type) as string | null | undefined) ?? null,
      interestMin: asNum(pickFirst(body.interestRateMin, body.interestMin, body.interest_min, body.minRate, body.min_rate)),
      interestMax: asNum(pickFirst(body.interestRateMax, body.interestMax, body.interest_max, body.maxRate, body.max_rate)),
      termMin: asNum(pickFirst(body.termMin, body.term_min, body.termLength?.min, body.term_length?.min)),
      termMax: asNum(pickFirst(body.termMax, body.term_max, body.termLength?.max, body.term_length?.max)),
      // BF_LP_COMMISSION_CREDIT_v36
      commission: bfNum(body.commission ?? body.commissionPercent ?? body.commission_percent),
      minCreditScore: bfNum(body.minCreditScore ?? body.min_credit_score),
      termUnit: asString(pickFirst(body.termUnit, body.term_unit, body.termLength?.unit, body.term_length?.unit)),
      amountMin: asNum(pickFirst(body.minAmount, body.amountMin, body.amount_min, body.min_amount)),
      amountMax: asNum(pickFirst(body.maxAmount, body.amountMax, body.amount_max, body.max_amount)),
      signnowTemplateId: asString(pickFirst(body.signnowTemplateId, body.signnow_template_id)),
      eligibilityNotes: asString(pickFirst(body.eligibilityRules, body.eligibilityNotes, body.eligibility_notes, body.notes)),
      silo,
    });
    res.status(201).json(decorateProductResponse(product));
  })
);

// PUT /api/portal/lender-products/:id
router.put(
  "/lender-products/:id",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    const body = req.body ?? {};
    const silo = getSilo(res);
    if (!id) throw new AppError("validation_error", "Product id is required.", 400);

    // BF_SERVER_v67_LENDER_PRODUCT_NAME_FALLBACK — accept body.productName
    // as a fallback for body.name. See POST handler comment above.
    const name =
      typeof body.name === "string" && body.name
        ? body.name
        : typeof body.productName === "string" && body.productName
          ? body.productName
          : "";
    if (!name) throw new AppError("validation_error", "name is required.", 400);

    const existing = await fetchLenderProductById(id, pool);
    if (!existing || (existing.silo && existing.silo !== silo)) throw new AppError("not_found", "Lender product not found.", 404);
    // BF_SERVER_BLOCK_v88_LENDER_PRODUCT_CATEGORY_NORMALIZE_v1
    let product;
    try {
      product = await updateLenderProduct({
        id,
        name,
        requiredDocuments: (() => {
        // BF_SERVER_BLOCK_v130_REQUIRED_DOCS_FORM_GUARD_v1
        const raw = body.requiredDocuments ?? body.required_documents ?? [];
        const { normalized, errors } = validateAndNormalizeRequiredDocuments(raw);
        if (errors.length > 0) {
          throw new AppError("validation_error", `required_documents invalid: ${errors.join("; ")}`, 400);
        }
        return normalized;
      })(),
        active: body.active,
        category: normalizeProductCategory(body.category),
        country: body.country,
        rateType: (pickFirst(body.rateType, body.rate_type) as string | null | undefined),
        interestMin: asNum(pickFirst(body.interestRateMin, body.interestMin, body.interest_min, body.minRate, body.min_rate)),
        interestMax: asNum(pickFirst(body.interestRateMax, body.interestMax, body.interest_max, body.maxRate, body.max_rate)),
        termMin: asNum(pickFirst(body.termMin, body.term_min, body.termLength?.min, body.term_length?.min)),
        termMax: asNum(pickFirst(body.termMax, body.term_max, body.termLength?.max, body.term_length?.max)),
        // BF_LP_COMMISSION_CREDIT_v36
        commission: bfNum(body.commission ?? body.commissionPercent ?? body.commission_percent),
        minCreditScore: bfNum(body.minCreditScore ?? body.min_credit_score),
        termUnit: asString(pickFirst(body.termUnit, body.term_unit, body.termLength?.unit, body.term_length?.unit)),
        amountMin: asNum(pickFirst(body.minAmount, body.amountMin, body.amount_min, body.min_amount)),
        amountMax: asNum(pickFirst(body.maxAmount, body.amountMax, body.amount_max, body.max_amount)),
        signnowTemplateId: asString(pickFirst(body.signnowTemplateId, body.signnow_template_id)),
        eligibilityNotes: asString(pickFirst(body.eligibilityRules, body.eligibilityNotes, body.eligibility_notes, body.notes)),
        client: pool,
      });
    } catch (err: any) {
      // BF_SERVER_BLOCK_v88_LENDER_PRODUCT_CATEGORY_NORMALIZE_v1
      // Surface the real Postgres error so 500s aren't opaque.
      console.error({
        event: "lender_product_update_failed",
        productId: id,
        category: body.category,
        normalizedCategory: normalizeProductCategory(body.category),
        pgCode: err?.code,
        pgConstraint: err?.constraint,
        pgDetail: err?.detail,
        pgTable: err?.table,
        message: err?.message,
      });
      if (err?.code === "23514") {
        // check_violation — return 400 with the constraint name so the
        // portal can surface a meaningful message.
        throw new AppError(
          "validation_error",
          `Value rejected by database constraint: ${err.constraint ?? "unknown"}`,
          400
        );
      }
      throw err;
    }
    if (!product) throw new AppError("not_found", "Lender product not found.", 404);
    res.status(200).json(decorateProductResponse(product));
  })
);

// DELETE /api/portal/lender-products/:id
router.delete(
  "/lender-products/:id",
  requireAuth,
  requireAdmin,
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) throw new AppError("validation_error", "Product id is required.", 400);
    const silo = getSilo(res);
    const userId = req.user?.id ?? req.user?.userId ?? null;
    try {
      await runQuery("DELETE FROM lender_products WHERE id = $1 AND (silo = $2 OR silo IS NULL)", [id, silo]);
      console.info({ event: "lender_product_deleted", lenderProductId: id, userId });
      res.status(204).end();
    } catch (err: any) {
      console.error({
        event: "lender_product_delete_failed",
        lenderProductId: id,
        userId,
        code: err?.code,
        message: err?.message,
        detail: err?.detail,
      });
      res.status(500).json({ error: { message: "delete_failed", code: err?.code ?? "unknown" } });
    }
  })
);

export default router;
