import express from "express";
import type { Express } from "express";
import { requestContextMiddleware } from "../observability/requestContext";
import { registerApiRouteMounts } from "../routes/routeRegistry";
import healthRoutes from "../routes/health";
import { errorHandler } from "../middleware/errorHandler";

export async function createServer(): Promise<Express> {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(requestContextMiddleware);

  app.use(healthRoutes);
  registerApiRouteMounts(app);

  app.use(errorHandler);

  return app;
}
