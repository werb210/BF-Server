import express from "express";
import { registerApiRouteMounts } from "./routes/routeRegistry";
import healthRoutes from "./routes/health";
import { requestContextMiddleware } from "./observability/requestContext";
import { errorHandler } from "./middleware/errorHandler";

export function buildAppWithApiRoutes() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(requestContextMiddleware);
  app.use(healthRoutes);
  registerApiRouteMounts(app);
  app.use(errorHandler);
  return app;
}
