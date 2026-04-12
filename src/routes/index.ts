import { Router } from "express";

const router = Router();

// 🔴 DO NOT use barrel exports or wildcard exports
// 🔴 DO NOT use require
// 🔴 DO NOT use export *

import healthRoutes from "./health.js";
import authRoutes from "./auth.js";

router.use("/health", healthRoutes);
router.use("/auth", authRoutes);

export default router;
