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

const processedIdempotencyKeys = new Set<string>();

export async function createServer(): Promise<Express> {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(requestContextMiddleware);
  app.use(requestTimeout);
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      console.log({
        path: req.path,
        status: res.statusCode,
        duration: Date.now() - start,
      });
    });
    next();
  });
  app.use("/api/", apiRateLimit);
  app.use("/api/", (req, res, next) => {
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

  app.use("/api/leads", leadRoutes);
  app.use("/api/lenders", lenderRoutes);
  app.use("/", healthRoutes);

  registerApiRouteMounts(app);

  app.use(errorHandler);

  return app;
}
