import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { buildLenderPackage } from "../../services/lenders/packageBuilder";
import { lenderProductsService } from "../../services/lenderProducts/lenderProducts.service";

const router = Router();

router.post("/send", requireAuth, async (req, res) => {
  try {
    const packageData = buildLenderPackage(req.body);
    res.json({ status: "sent", package: packageData });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Failed to send package";
    res.status(500).json({ error });
  }
});

router.get("/products", requireAuth, async (_req, res, next) => {
  try {
    const products = await lenderProductsService.list();
    res.json(products);
  } catch (err) {
    next(err);
  }
});

export default router;
