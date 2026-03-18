import { Router } from "express";
import telephonyRoutes from "../telephony/routes/telephonyRoutes";
import authRoutes from "../modules/auth/auth.routes";
import systemRoutes from "./systemRoutes";
import { pool } from "../db";

const apiRouter = Router();

apiRouter.use("/telephony", telephonyRoutes);
apiRouter.use("/auth", authRoutes);
apiRouter.get("/debug/otp_sessions", async (_req, res) => {
  const rows = await pool.query(`select * from otp_sessions order by created_at desc limit 10`);
  res.json({ ok: true, data: rows.rows });
});

apiRouter.use("/", systemRoutes);

export default apiRouter;
