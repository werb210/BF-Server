import express from "express";
import rateLimit from "express-rate-limit";
import leadRoutes from "../modules/lead/lead.routes";
import lenderRoutes from "../modules/lender/lender.routes";
import { requestContext } from "../middleware/requestContext";
import { errorHandler } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/auth";

export function registerRoutes(app: express.Application): void {
  app.use("/api", requireAuth);
  app.use("/api/leads", leadRoutes);
  app.use("/api/lenders", lenderRoutes);

  app.use((_req, res) => {
    res.status(404).json({
      error: { message: "not_found" },
    });
  });
}

export function createServer() {
  const app = express();

  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 100,
    }),
  );

  app.use(express.json());
  app.use(requestContext);

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/readyz", (_req, res) => res.json({ ok: true }));

  registerRoutes(app);
  app.use(errorHandler);

  return app;
}
