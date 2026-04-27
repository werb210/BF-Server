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
function asString(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s === "" ? null : s;
}
function decorateProductResponse(product: any): any {
  if (!product || typeof product !== "object") return product;
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
  };
}


// GET /api/portal/lender-products[?lenderId=...]
router.get(
  "/lender-products",
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
router.get(
  "/lender-products/:id",
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

    const name = typeof body.name === "string" ? body.name : "";
    const category = typeof body.category === "string" ? body.category : "LOC";

    if (!lenderId) throw new AppError("validation_error", "lenderId is required.", 400);
    if (!name) throw new AppError("validation_error", "name is required.", 400);

    const product = await createLenderProduct({
      lenderId,
      name,
      active: body.active ?? true,
      category,
      requiredDocuments: body.requiredDocuments ?? body.required_documents ?? [],
      country: body.country ?? null,
      rateType: (pickFirst(body.rateType, body.rate_type) as string | null | undefined) ?? null,
      interestMin: asNum(pickFirst(body.interestRateMin, body.interestMin, body.interest_min, body.minRate, body.min_rate)),
      interestMax: asNum(pickFirst(body.interestRateMax, body.interestMax, body.interest_max, body.maxRate, body.max_rate)),
      termMin: asNum(pickFirst(body.termMin, body.term_min, body.termLength?.min, body.term_length?.min)),
      termMax: asNum(pickFirst(body.termMax, body.term_max, body.termLength?.max, body.term_length?.max)),
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

    const name = typeof body.name === "string" ? body.name : "";
    if (!name) throw new AppError("validation_error", "name is required.", 400);

    const existing = await fetchLenderProductById(id, pool);
    if (!existing || (existing.silo && existing.silo !== silo)) throw new AppError("not_found", "Lender product not found.", 404);
    const product = await updateLenderProduct({
      id,
      name,
      requiredDocuments: body.requiredDocuments ?? body.required_documents ?? [],
      active: body.active,
      category: body.category,
      country: body.country,
      rateType: (pickFirst(body.rateType, body.rate_type) as string | null | undefined),
      interestMin: asNum(pickFirst(body.interestRateMin, body.interestMin, body.interest_min, body.minRate, body.min_rate)),
      interestMax: asNum(pickFirst(body.interestRateMax, body.interestMax, body.interest_max, body.maxRate, body.max_rate)),
      termMin: asNum(pickFirst(body.termMin, body.term_min, body.termLength?.min, body.term_length?.min)),
      termMax: asNum(pickFirst(body.termMax, body.term_max, body.termLength?.max, body.term_length?.max)),
      termUnit: asString(pickFirst(body.termUnit, body.term_unit, body.termLength?.unit, body.term_length?.unit)),
      amountMin: asNum(pickFirst(body.minAmount, body.amountMin, body.amount_min, body.min_amount)),
      amountMax: asNum(pickFirst(body.maxAmount, body.amountMax, body.amount_max, body.max_amount)),
      signnowTemplateId: asString(pickFirst(body.signnowTemplateId, body.signnow_template_id)),
      eligibilityNotes: asString(pickFirst(body.eligibilityRules, body.eligibilityNotes, body.eligibility_notes, body.notes)),
      client: pool,
    });
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
