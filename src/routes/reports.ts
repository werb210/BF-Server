import { Router } from "express";
import reportingRoutes from "../modules/reporting/reporting.routes.js";
import reportsSectionRoutes from "./reportsSection.js"; // BF_SERVER_REPORTS_SECTION_v714
import mobileAppsReportRoutes from "./mobileAppsReport.js"; // BF_SERVER_v811_MOBILE_APPS_REPORT

const router = Router();
router.use(reportsSectionRoutes); // BF_SERVER_REPORTS_SECTION_v714
router.use(mobileAppsReportRoutes); // BF_SERVER_v811_MOBILE_APPS_REPORT
router.use("/", reportingRoutes);

export default router;
