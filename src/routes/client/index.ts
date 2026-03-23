import { Router } from "express";
import continuationRouter from "./continuation";
import documentsRouter from "./documents";
import applicationsRouter from "./applications";
import lendersRouter from "./lenders";
import lenderProductsRouter from "./lenderProducts";
import clientSubmissionRoutes from "../../modules/clientSubmission/clientSubmission.routes";
import sessionRouter from "./session";
import {
  clientDocumentsRateLimit,
  clientReadRateLimit,
} from "../../middleware/rateLimit";

const router = Router();
const clientReadLimiter = clientReadRateLimit();

router.use((req: any, res: any, next: any) => {
  if (req.method === "GET") {
    clientReadLimiter(req: any, res: any, next: any);
    return;
  }
  next();
});

router.use("/", continuationRouter);
router.use("/", applicationsRouter);
router.use("/lenders", lendersRouter);
router.use("/", lenderProductsRouter);
router.use("/", clientSubmissionRoutes);
router.use("/", sessionRouter);
router.use("/documents", clientDocumentsRateLimit(), documentsRouter);

export default router;
