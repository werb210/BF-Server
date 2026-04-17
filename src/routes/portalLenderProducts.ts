/**
 * Portal lender-products CRUD routes.
 * Mounted at /api/portal by routeRegistry — all paths are relative to that prefix.
 */
import { Router } from "express";
import { pool, runQuery } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { AppError } from "../middleware/errors.js";
import {
  listLenderProducts,
  listLenderProductsByLenderId,
  fetchLenderProductById,
  createLenderProduct,
  updateLenderProduct,
} from "../repositories/lenderProducts.repo.js";

const router = Router();

// GET /api/portal/lender-products[?lenderId=...]
router.get(
  "/lender-products",
  safeHandler(async (req: any, res: any) => {
    const lenderId =
      typeof req.query.lenderId === "string" ? req.query.lenderId.trim() : "";
    const products = lenderId
      ? await listLenderProductsByLenderId(lenderId, pool)
      : await listLenderProducts(pool);
    res.status(200).json({ items: products ?? [] });
  })
);

// GET /api/portal/lender-products/:id
router.get(
  "/lender-products/:id",
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) throw new AppError("validation_error", "Product id is required.", 400);
    const product = await fetchLenderProductById(id, pool);
    if (!product) throw new AppError("not_found", "Lender product not found.", 404);
    res.status(200).json(product);
  })
);

// POST /api/portal/lender-products
router.post(
  "/lender-products",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const body = req.body ?? {};
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
      rateType: body.rateType ?? body.rate_type ?? null,
      interestMin: body.interestMin ?? body.interest_min ?? null,
      interestMax: body.interestMax ?? body.interest_max ?? null,
      termMin: body.termMin ?? body.term_min ?? null,
      termMax: body.termMax ?? body.term_max ?? null,
    });
    res.status(201).json(product);
  })
);

// PUT /api/portal/lender-products/:id
router.put(
  "/lender-products/:id",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    const body = req.body ?? {};
    if (!id) throw new AppError("validation_error", "Product id is required.", 400);

    const name = typeof body.name === "string" ? body.name : "";
    if (!name) throw new AppError("validation_error", "name is required.", 400);

    const product = await updateLenderProduct({
      id,
      name,
      requiredDocuments: body.requiredDocuments ?? body.required_documents ?? [],
      active: body.active,
      category: body.category,
      country: body.country,
      rateType: body.rateType ?? body.rate_type,
      interestMin: body.interestMin ?? body.interest_min,
      interestMax: body.interestMax ?? body.interest_max,
      termMin: body.termMin ?? body.term_min,
      termMax: body.termMax ?? body.term_max,
      client: pool,
    });
    if (!product) throw new AppError("not_found", "Lender product not found.", 404);
    res.status(200).json(product);
  })
);

// DELETE /api/portal/lender-products/:id
router.delete(
  "/lender-products/:id",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) throw new AppError("validation_error", "Product id is required.", 400);
    await runQuery("DELETE FROM lender_products WHERE id = $1", [id]);
    res.status(204).end();
  })
);

export default router;
