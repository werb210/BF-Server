import express from "express";
import type { Express } from "express";
import { requestContextMiddleware } from "../observability/requestContext";
import { registerApiRouteMounts } from "../routes/routeRegistry";
import leadRoutes from "../modules/lead/lead.routes";
import lenderRoutes from "../modules/lender/lender.routes";
import healthRoutes from "../modules/health/health.routes";
import { errorHandler } from "../middleware/errorHandler";

export async function createServer(): Promise<Express> {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(requestContextMiddleware);

  app.use("/api/leads", leadRoutes);
  app.use("/api/lenders", lenderRoutes);
  app.use("/", healthRoutes);

  registerApiRouteMounts(app);

  app.use(errorHandler);

  return app;
}
