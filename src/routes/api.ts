import { Router } from "express";
import telephonyRoutes from "../telephony/routes/telephonyRoutes";
import authRoutes from "./auth";

const apiRouter = Router();

apiRouter.use("/telephony", telephonyRoutes);
apiRouter.use("/auth", authRoutes);

export default apiRouter;
