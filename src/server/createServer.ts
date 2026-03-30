import express from "express";
import cookieParser from "cookie-parser";
import { corsMiddleware } from "../middleware/cors";
import { securityHeaders } from "../middleware/security";
import { httpMetricsMiddleware } from "../metrics/httpMetrics";
import { requestContextMiddleware } from "../observability/requestContext";
import { errorHandler } from "../middleware/errorHandler";
import { registerApiRouteMounts } from "../routes/routeRegistry";
import authRoutes from "../routes/auth.routes";
import { requireAuth } from "../middleware/auth";
import { authMeHandler } from "../routes/auth/me";

export function createServer() {
  const app = express();

  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));
  app.use(requestContextMiddleware);
  app.use(httpMetricsMiddleware);

  app.get("/", (_req, res) => {
    res.status(200).send("ok");
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/auth", authRoutes);
  app.use("/api/auth", authRoutes);
  app.get("/api/auth/me", requireAuth, authMeHandler);

  registerApiRouteMounts(app);

  app.use(errorHandler);

  return app;
}
