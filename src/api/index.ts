import express from "express";

import authRoutes from "../routes/auth";
import crmRoutes from "../routes/crm";
import supportRoutes from "../routes/support";
import telephonyRoutes from "../telephony/routes/telephonyRoutes";
import applicationsRoutes from "../modules/applications/applications.routes";

const router = express.Router();

// CONTRACT (driven by portal usage)
router.use("/auth", authRoutes);
router.use("/applications", applicationsRoutes);
router.use("/crm", crmRoutes);
router.use("/support", supportRoutes);
router.use("/telephony", telephonyRoutes);

export default router;
