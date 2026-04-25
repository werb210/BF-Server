import { Router } from "express";
import { AppError } from "../../middleware/errors.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { listLenderProducts } from "../../repositories/lenderProducts.repo.js";
import {
  listRequirementsForFilters,
  resolveLenderProductRequirements,
} from "../../services/lenderProductRequirementsService.js";

const router = Router();

/**
 * GET /api/client/lender-products
 * Public — used by BF-client wizard Step 2 to render product categories.
 * Returns the full shape the wizard expects; do NOT truncate fields here.
 */
router.get(
  "/lender-products",
  safeHandler(async (_req: any, res: any) => {
    const products = await listLenderProducts();
    const active = products.filter((p: any) => p.active !== false);

    const payload = active.map((p: any) => ({
      id:                 p.id,
      name:               p.name,
      product_type:       p.category,          // client expects product_type
      country:            p.country ?? "BOTH",
      amount_min:         p.amount_min ?? null,
      amount_max:         p.amount_max ?? null,
      term:               p.term_min && p.term_max ? `${p.term_min}-${p.term_max}` : p.term_min ?? p.term_max ?? null,
      rate:               p.rate_type === "VARIABLE"
                            ? "P+"
                            : (p.interest_min && p.interest_max ? `${p.interest_min}-${p.interest_max}` : p.interest_min ?? p.interest_max ?? null),
      required_documents: Array.isArray(p.required_documents) ? p.required_documents : [],
      lender_id:          p.lender_id,
      lender_name:        p.lender_name ?? null,
      status:             p.active ? "active" : "inactive",
    }));

    res.status(200).json({ status: "ok", data: payload });
  })
);

router.get(
  "/lender-products/:id/requirements",
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) throw new AppError("validation_error", "Invalid request", 400);
    const requirements = await resolveLenderProductRequirements({ lenderProductId: id });
    res.status(200).json({ status: "ok", data: requirements });
  })
);

router.get(
  "/lender-products/requirements",
  safeHandler(async (req: any, res: any) => {
    const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
    if (!category) throw new AppError("validation_error", "Invalid request", 400);
    const country = typeof req.query.country === "string" ? req.query.country : undefined;
    const raw = typeof req.query.requestedAmount === "string" ? Number(req.query.requestedAmount) : null;
    const requestedAmount = Number.isFinite(raw as number) ? (raw as number) : null;
    const requirements = await listRequirementsForFilters({ category, country, requestedAmount });
    res.status(200).json({ status: "ok", data: requirements });
  })
);

export default router;
