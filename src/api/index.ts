import express from "express";

// AUTH (already clean)
import authRoutes from "../routes/auth";

// CORE DOMAINS (REAL IMPLEMENTATIONS)
import applicationsRoutes from "../modules/applications/applications.routes";
import crmRoutes from "../routes/crm";
import supportRoutes from "../routes/support";

// TELEPHONY (USE ONE SOURCE ONLY)
import telephonyRoutes from "../telephony/routes/telephonyRoutes";

// CLIENT + LENDERS
import lendersRoutes from "../routes/lenders";
import lenderProductsRoutes from "../routes/lenderProducts";

// PUBLIC / READINESS
import readinessRoutes from "../routes/readiness";
import publicRoutes from "../routes/public";

// ANALYTICS / DASHBOARD
import dashboardRoutes from "../routes/dashboard";

const router = express.Router();

// === CONTRACT (BASED ON PORTAL USAGE) ===
router.use("/auth", authRoutes);
router.use("/applications", applicationsRoutes);
router.use("/crm", crmRoutes);
router.use("/support", supportRoutes);
router.use("/telephony", telephonyRoutes);

router.use("/lenders", lendersRoutes);
router.use("/lender-products", lenderProductsRoutes);

router.use("/readiness", readinessRoutes);
router.use("/public", publicRoutes);

router.use("/dashboard", dashboardRoutes);

export default router;
