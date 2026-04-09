import { Router } from "express";
import continuationRouter from "./continuation.js";
import documentsRouter from "./documents.js";
import applicationsRouter from "./applications.js";
import lendersRouter from "./lenders.js";
import lenderProductsRouter from "./lenderProducts.js";
import clientSubmissionRoutes from "../../modules/clientSubmission/clientSubmission.routes.js";
import sessionRouter from "./session.js";
import { clientDocumentsRateLimit, clientReadRateLimit, } from "../../middleware/rateLimit.js";
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
router.use("/lenders", lendersRouter);
router.use("/", lenderProductsRouter);
router.use("/", clientSubmissionRoutes);
router.use("/", sessionRouter);
router.use("/documents", clientDocumentsRateLimit(), documentsRouter);
export default router;
