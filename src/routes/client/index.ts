import { Router } from "express";
import continuationRouter from "./continuation";
import documentsRouter from "./documents";
import applicationsRouter from "./applications";
import lenderProductsRouter from "./lenderProducts";
import lendersRouter from "./lenders";
import clientSubmissionRoutes from "../../modules/clientSubmission/clientSubmission.routes";
import {
  clientDocumentsRateLimit,
  clientReadRateLimit,
} from "../../middleware/rateLimit";

const router = Router();
const clientReadLimiter = clientReadRateLimit();

router.use((req, res, next) => {
  if (req.method === "GET") {
    clientReadLimiter(req, res, next);
    return;
  }
  next();
});

router.use("/", continuationRouter);
router.use("/", applicationsRouter);
router.use("/", lenderProductsRouter);
router.use("/lenders", lendersRouter);
router.use("/", clientSubmissionRoutes);
router.use("/documents", clientDocumentsRateLimit(), documentsRouter);

export default router;
