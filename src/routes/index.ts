import { Router } from "express";
import authRoutes from "./auth";
import systemRoutes from "./systemRoutes";
import telephonyRoutes from "../telephony/routes/telephonyRoutes";

const router = Router();

router.use("/telephony", telephonyRoutes);
router.use("/auth", authRoutes);
router.use("/api", systemRoutes);

export default router;
