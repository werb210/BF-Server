import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { Router } from "express";

import authRoutes, { resetOtpStateForTests as resetAuthOtpStateForTests } from "./routes/auth.js";
import callRoutes from "./routes/call.js";
import healthRoutes from "./routes/health.js";
import publicRoutes from "./routes/public.js";
import { applySiloMiddleware, registerApiRouteMounts } from "./routes/routeRegistry.js";
import { requireAuth } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errors.js";
import { listRoutes } from "./debug/printRoutes.js";

export function createApp() {
  const app = express();
  // Trust Azure App Service reverse proxy
  app.set("trust proxy", 1);
  /**
   * CORS configuration
   *
   * Allowed origins are determined by the CORS_ALLOWED_ORIGINS env var when
   * present. The variable may contain a comma-separated list of origins.
   * If unset, fallback to the default portal/local allowlist.
   */
  const defaultOrigins = [
    "https://staff.boreal.financial",
    "https://client.boreal.financial",
    "https://boreal.financial",
    "https://www.boreal.financial",
    "http://localhost:3000",
    "http://localhost:5173",
  ];
  const envOrigins = process.env.CORS_ALLOWED_ORIGINS;
  const allowedOrigins = typeof envOrigins === "string" && envOrigins.length > 0
    ? envOrigins.split(",").map((origin) => origin.trim()).filter(Boolean)
    : defaultOrigins;
  const corsOptions: cors.CorsOptions = {
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // BF_SERVER_BLOCK_v639_CORS_MAYA_AUDIENCE_v1 — portal sends X-Maya-Audience
    // (staff|client|visitor) on every Maya call. Without it in the allowlist the
    // browser blocks the preflight with "Request header field x-maya-audience
    // is not allowed by Access-Control-Allow-Headers" — visible in console of
    // shot_4_48_11 of Todd's BI silo. v638 also wires the proxy to forward it.
    allowedHeaders: ["Content-Type", "Authorization", "x-silo", "X-Request-Id", "x-maya-audience"],
    credentials: true,
  };

  /**
   * CORE MIDDLEWARE
   */
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://sdk.twilio.com",
        ],
        connectSrc: [
          "'self'",
          "https://server.boreal.financial",
          "https://staff.boreal.financial",
          "https://client.boreal.financial",
          "https://boreal.financial",

          // Twilio REST / signaling
          "https://voice-js.twilio.com",
          "https://voice-js.roaming.twilio.com",
          "https://eventgw.twilio.com",
          "https://sdk.twilio.com",

          // WebSocket signaling
          "wss://voice-js.twilio.com",
          "wss://voice-js.roaming.twilio.com",
          "wss://eventgw.twilio.com",
        ],
        mediaSrc: [
          "'self'",
          "blob:",
          "https://media.twiliocdn.com",
        ],

        imgSrc: ["'self'", "data:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", "data:"],
        frameSrc: ["'self'"],
      },
    },
  }));

  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));

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

    registerApiRouteMounts(apiRouter);

  // Apply request silo extraction for all API routes
  applySiloMiddleware(app);

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
   * BF_AGENT_AUTH_HYDRATE_v53 — wire the canonical errorHandler from
   * middleware/errors.ts so AppError responses surface their actual status
   * (404, 400, 409, etc.) instead of being mis-coerced to 500. The previous
   * inline handler was a 500-everything fallback that broke wizard recovery
   * and any client logic that branches on specific error codes.
   */
  app.use(errorHandler);

  return app;
}

export function resetOtpStateForTests() {
  resetAuthOtpStateForTests();
}
