import { Router } from "express";
import reportingRoutes from "../modules/reporting/reporting.routes.js";
import reportsSectionRoutes from "./reportsSection.js"; // BF_SERVER_REPORTS_SECTION_v714

const router = Router();
router.use(reportsSectionRoutes); // BF_SERVER_REPORTS_SECTION_v714
router.use("/", reportingRoutes);

export default router;
