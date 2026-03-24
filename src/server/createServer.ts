import express from "express";
import type { Express } from "express";
import { apiRateLimit } from "../middleware/rateLimit";
import { requestTimeout } from "../middleware/requestTimeout";
import { requestContextMiddleware } from "../observability/requestContext";
import { registerApiRouteMounts } from "../routes/routeRegistry";
import leadRoutes from "../modules/lead/lead.routes";
import lenderRoutes from "../modules/lender/lender.routes";
import healthRoutes from "../modules/health/health.routes";
import { errorHandler } from "../middleware/errorHandler";
import { securityHeaders } from "../middleware/security";
import { corsMiddleware } from "../middleware/cors";
import { logger } from "./utils/logger";
import { httpMetricsMiddleware } from "../metrics/httpMetrics";
import { bindSentryErrorHandler } from "../observability/sentry";
import { config } from "../config";

const processedIdempotencyKeys = new Set<string>();

export async function createServer(): Promise<Express> {
  const app = express();

  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(express.json({ limit: "1mb" }));
  app.use(requestContextMiddleware);
  app.use(httpMetricsMiddleware);
  app.use(requestTimeout);
  app.use((req: any, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method.toUpperCase())) {
      next();
      return;
    }

    res.on("finish", () => {
      logger.info("audit_event", {
        event: "api_mutation",
        method: req.method,
        path: req.path,
        status: res.statusCode,
        userId: req.user?.userId ?? null,
      });
    });

    next();
  });
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      logger.info("http_request_completed", {
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
    });
    next();
  });
  app.use("/api/v1/", apiRateLimit);
  if (config.flags.allowUnfrozenApiV1) {
    app.use("/api/", apiRateLimit);
  }
  app.use("/api/v1/", (req, res, next) => {
    if (req.method.toUpperCase() !== "POST") {
      next();
      return;
    }

    const key = req.header("idempotency-key")?.trim();
    if (!key) {
      next();
      return;
    }

    if (processedIdempotencyKeys.has(key)) {
      res.json({ status: "duplicate" });
      return;
    }

    processedIdempotencyKeys.add(key);
    next();
  });

  app.use("/api/v1/leads", leadRoutes);
  app.use("/api/v1/lenders", lenderRoutes);

  app.use("/api/leads", leadRoutes);
  app.use("/api/lenders", lenderRoutes);
  logger.info("routes_mounted", { routes: ["/api/leads", "/api/lenders"] });
  app.use("/", healthRoutes);

  registerApiRouteMounts(app);

  app.use((req, res) => {
    res.status(404).json({
      error: "Route not found",
      path: req.path,
    });
  });

  bindSentryErrorHandler(app);
  app.use(errorHandler);

  return app;
}
