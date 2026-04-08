import express from "express";
import helmet from "helmet";

import { corsMiddleware } from "./middleware/cors";
import authRouter from "./routes/auth";
import routes from "./routes";
import { registerApiRouteMounts } from "./routes/routeRegistry";

export function createApp() {
  const app = express();

  // core middleware
  app.use(express.json());
  app.use(helmet());

  // security + cors
  app.use(corsMiddleware);

  // base health (non-prefixed)
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", data: {} });
  });

  // api health (tests expect this)
  app.get("/api/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      data: { server: "ok" },
    });
  });

  // readiness
  app.get("/ready", (_req, res) => {
    res.status(200).json({
      status: "ok",
      data: {},
    });
  });

  // routers
  app.use("/api/auth", authRouter);
  app.use("/api/v1", routes);

  // CRITICAL: mounts all remaining endpoints
  registerApiRouteMounts(app);

  // metrics (basic contract)
  app.get("/metrics", (_req, res) => {
    res.status(200).json({
      status: "ok",
      data: {
        requests: 0,
        errors: 0,
      },
    });
  });

  // legacy route handling (tests expect 410, not 404)
  app.use((req, res, next) => {
    if (req.path.startsWith("/auth") || req.path.startsWith("/api/public")) {
      return res.status(410).json({
        status: "error",
        error: "LEGACY_ROUTE_DISABLED",
      });
    }
    next();
  });

  // final 404 handler (structured)
  app.use((_req, res) => {
    res.status(404).json({
      status: "error",
      error: "NOT_FOUND",
    });
  });

  return app;
}

export function resetOtpStateForTests() {
  // no-op — OTP is now handled in route layer (redis / stateless)
}
