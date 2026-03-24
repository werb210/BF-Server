import express from "express";
import { registerApiRouteMounts } from "./routes/routeRegistry";
import healthRoutes from "./routes/health";
import { requestContextMiddleware } from "./observability/requestContext";
import { errorHandler } from "./middleware/errorHandler";
import { securityHeaders } from "./middleware/security";
import { corsMiddleware } from "./middleware/cors";
import { httpMetricsMiddleware } from "./metrics/httpMetrics";

export function buildAppWithApiRoutes() {
  const app = express();
  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(express.json({ limit: "1mb" }));
  app.use(requestContextMiddleware);
  app.use(httpMetricsMiddleware);
  app.use(healthRoutes);
  registerApiRouteMounts(app);
  app.use(errorHandler);
  return app;
}
