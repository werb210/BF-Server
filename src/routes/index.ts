import { Router } from "express";
import authRoutes from "./auth";
import telephonyRoutes from "../telephony/routes/telephonyRoutes";

const router = Router();

router.use("/telephony", telephonyRoutes);
router.use("/auth", authRoutes);

export default router;
