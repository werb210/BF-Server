import express from "express";
import rateLimit from "express-rate-limit";
import authRoutes from "../modules/auth/auth.routes";
import applicationRoutes from "../modules/applications/applications.routes";
import leadRoutes from "../modules/lead/lead.routes";
import lenderRoutes from "../modules/lender/lender.routes";
import telephonyRoutes from "../modules/telephony/token.route";
import { requestContext } from "../middleware/requestContext";
import { errorHandler } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/auth";
import { corsMiddleware } from "../middleware/cors";

export function registerRoutes(app: express.Application): void {
  app.use("/api/auth", authRoutes);

  app.use("/api", requireAuth);

  app.use("/api/applications", applicationRoutes);
  app.use("/api/leads", leadRoutes);
  app.use("/api/lenders", lenderRoutes);
  app.use("/api/telephony", telephonyRoutes);

  app.use((_req, res) => {
    res.status(404).json({
      error: {
        message: "Not Found",
        code: "not_found",
      },
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

  app.use(corsMiddleware);
  app.use(express.json());
  app.use(requestContext);

  app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/readyz", (_req, res) => res.status(200).json({ ok: true }));

  registerRoutes(app);
  app.use(errorHandler);

  return app;
}
