import { Router } from "express";
import reportingRoutes from "../modules/reporting/reporting.routes.js";

const router = Router();
router.use("/", reportingRoutes);

export default router;
