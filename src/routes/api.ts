import { Router } from "express";
import telephonyRoutes from "../telephony/routes/telephonyRoutes";
import authRoutes from "../modules/auth/auth.routes";
import systemRoutes from "./systemRoutes";

const apiRouter = Router();

apiRouter.use("/telephony", telephonyRoutes);
apiRouter.use("/auth", authRoutes);
apiRouter.use("/", systemRoutes);

export default apiRouter;
