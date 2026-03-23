import { Router } from "express";
import { AppError } from "../../middleware/errors";
import { safeHandler } from "../../middleware/safeHandler";
import { listLenderProducts } from "../../repositories/lenderProducts.repo";
import { listRequirementsForFilters, resolveLenderProductRequirements } from "../../services/lenderProductRequirementsService";

const router = Router();

router.get(
  "/lender-products",
  safeHandler(async (_req, res) => {
    const products = await listLenderProducts();
    res.status(200).json(products.map((p) => ({ id: p.id, name: p.name, type: p.category })));
  })
);

router.get(
  "/lender-products/:id/requirements",
  safeHandler(async (req: any, res: any, next: any) => {
    const lenderProductId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!lenderProductId) {
      throw new AppError("validation_error", "Invalid request", 400);
    }
    const requirements = await resolveLenderProductRequirements({ lenderProductId });
    res.status(200).json(requirements);
  })
);

router.get(
  "/lender-products/requirements",
  safeHandler(async (req: any, res: any, next: any) => {
    const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
    if (!category) {
      throw new AppError("validation_error", "Invalid request", 400);
    }

    const country = typeof req.query.country === "string" ? req.query.country : undefined;
    const requestedAmountRaw =
      typeof req.query.requestedAmount === "string" && req.query.requestedAmount.trim().length > 0
        ? Number(req.query.requestedAmount)
        : null;
    const requestedAmount =
      typeof requestedAmountRaw === "number" && Number.isFinite(requestedAmountRaw)
        ? requestedAmountRaw
        : null;

    const requirements = await listRequirementsForFilters({
      category,
      country,
      requestedAmount,
    });

    res.status(200).json(requirements);
  })
);

export default router;
