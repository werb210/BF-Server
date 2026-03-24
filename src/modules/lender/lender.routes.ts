import { type Request, Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth";
import { buildLenderPackage } from "../../services/lenders/packageBuilder";
import { lenderProductsService } from "../../services/lenderProducts/lenderProducts.service";
import { enqueueLenderPackage, getLenderQueue } from "../../queue/lenderQueue";
import { logger } from "../../server/utils/logger";

const sendLenderPackageSchema = z.object({
  application: z.object({}).passthrough(),
  documents: z.array(z.unknown()),
  creditSummary: z.object({}).passthrough(),
});

type SendLenderPackageBody = z.infer<typeof sendLenderPackageSchema>;

const router = Router();

router.post("/send", requireAuth, async (req: Request<{}, {}, SendLenderPackageBody>, res, next) => {
  try {
    const body = sendLenderPackageSchema.parse(req.body);
    const packageData = buildLenderPackage(body);

    const queue = getLenderQueue();
    if (queue) {
      try {
        const jobId = await enqueueLenderPackage(body);
        res.status(202).json({ status: "queued", jobId, packagePreview: packageData });
        return;
      } catch (queueErr) {
        logger.warn("lender_package_queue_unavailable", {
          err: queueErr instanceof Error ? queueErr.message : String(queueErr),
        });
      }
    }

    res.json({ status: "sent", package: packageData, mode: "sync_fallback" });
  } catch (err) {
    next(err);
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
