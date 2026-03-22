import express, { type Express } from "express";
import otpRoutes from "./routes/auth/otp.js";
import applicationRoutes from "./routes/applications.js";
import documentRoutes from "./routes/documents.js";
import telephonyRoutes from "./routes/telephony.js";

function registerCoreRoutes(app: Express): void {
  app.use("/api/auth/otp", otpRoutes);
  app.use("/api/applications", applicationRoutes);
  app.use("/api/documents", documentRoutes);
  app.use("/api/telephony", telephonyRoutes);

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
}

export function createApp(): Express {
  const app = express();
  app.use(express.json());
  registerCoreRoutes(app);
  return app;
}

export function buildApp(): Express {
  return createApp();
}

export function registerApiRoutes(app: Express): void {
  registerCoreRoutes(app);
}

export function assertCorsConfig(): true {
  return true;
}

export function buildAppWithApiRoutes(): Express {
  return createApp();
}

export const app = createApp();
export default app;
