import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { Router } from "express";

import authRoutes, { resetOtpStateForTests as resetAuthOtpStateForTests } from "./routes/auth.js";
import callRoutes from "./routes/call.js";
import healthRoutes from "./routes/health.js";
import publicRoutes from "./routes/public.js";
import { registerApiRouteMounts } from "./routes/routeRegistry.js";
import { requireAuth } from "./middleware/auth.js";
import { listRoutes } from "./debug/printRoutes.js";

export function createApp() {
  const app = express();
  // Trust Azure App Service reverse proxy
  app.set("trust proxy", 1);
  const HARDCODED_ALLOWED_ORIGINS = [
    "https://staff.boreal.financial",
    "https://client.boreal.financial",
    "https://boreal.financial",
    "https://www.boreal.financial",
  ];

  const envOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const allowedOrigins = [...new Set([...envOrigins, ...HARDCODED_ALLOWED_ORIGINS])];

  /**
   * CORE MIDDLEWARE
   */
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://sdk.twilio.com"],
        connectSrc: [
          "'self'",
          "https://server.boreal.financial",
          "https://voice-js.twilio.com",
          "wss://voice-js.roaming.twilio.com",
          "wss://chunderw-vpc-gll.twilio.com",
          "https://eventgw.twilio.com",
          "wss://eventgw.twilio.com",
          "https://media.twiliocdn.com",
          "wss://*.twilio.com",
          "https://sdk.twilio.com",
        ],
        imgSrc: ["'self'", "data:", "https:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", "data:"],
        mediaSrc: ["'self'", "https://media.twiliocdn.com"],
      },
    },
  }));

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  }));

  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());

  /**
   * HEALTH (MUST NOT BE CAUGHT BY FRONTEND)
   */
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/api/_int/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  /**
   * API ROUTES (LOCKED PREFIX)
   */
  const apiRouter = Router();

  apiRouter.use("/auth", authRoutes);
  apiRouter.use("/call", callRoutes);
  apiRouter.use("/health", healthRoutes);
  apiRouter.use("/public", publicRoutes);

  // TODO: Wire real Twilio voice implementation via telephonyRoutes
  // These return 501 so callers (iOS dialer, portal) get an honest error
  // instead of silently believing the action succeeded.
  apiRouter.post("/voice/device-token", requireAuth, (_req, res) => {
    res.status(501).json({ status: "error", error: "not_implemented", message: "Voice device token endpoint not yet wired" });
  });
  apiRouter.post("/voice/calls/answer", requireAuth, (_req, res) => {
    res.status(501).json({ status: "error", error: "not_implemented", message: "Voice answer endpoint not yet wired" });
  });
  apiRouter.post("/voice/calls/end", requireAuth, (_req, res) => {
    res.status(501).json({ status: "error", error: "not_implemented", message: "Voice end endpoint not yet wired" });
  });
  apiRouter.get("/voice/calls/log", requireAuth, (_req, res) => {
    res.status(501).json({ status: "error", error: "not_implemented", message: "Voice call log endpoint not yet wired" });
  });
  apiRouter.post("/voice/record/start", requireAuth, (_req, res) => {
    res.status(501).json({ status: "error", error: "not_implemented", message: "Voice record start endpoint not yet wired" });
  });
  apiRouter.post("/voice/record/stop", requireAuth, (_req, res) => {
    res.status(501).json({ status: "error", error: "not_implemented", message: "Voice record stop endpoint not yet wired" });
  });
  apiRouter.post("/sms/send", requireAuth, (_req, res) => {
    res.status(501).json({ status: "error", error: "not_implemented", message: "SMS send endpoint not yet wired" });
  });
  registerApiRouteMounts(apiRouter);

  // 1. API ROUTES FIRST
  app.use("/api", apiRouter);

  const routes = listRoutes(app);
  routes.forEach((entry) => {
    console.log([entry.method.toLowerCase()], entry.path);
  });

  /**
   * FRONTEND FALLBACK GUARD
   * Keep API traffic out of SPA/static fallback handlers.
   */
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.status(404).json({ error: "Route not found", path: req.originalUrl });
  });

  /**
   * 404 HANDLER
   */
  app.use("*", (req, res) => {
    res.status(404).json({ error: "Route not found", path: req.originalUrl });
  });

  /**
   * GLOBAL ERROR HANDLER
   */
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("SERVER ERROR:", err);
    res.status(500).json({
      status: "error",
      message: err?.message ?? "Internal Server Error",
    });
  });

  return app;
}

export function resetOtpStateForTests() {
  resetAuthOtpStateForTests();
}
