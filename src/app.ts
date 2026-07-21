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
  // BF_SERVER_CORS_LOCAL_PREVIEW_v1 - allow the native app (capacitor://localhost)
  // and local dev preview (localhost / 127.0.0.1 / RFC1918 LAN on any port) in
  // addition to the configured allowlist. Non-browser and same-origin requests
  // (no Origin header) are allowed. Public origins still require the allowlist.
  const isLocalPreviewOrigin = (origin: string): boolean =>
    origin === "capacitor://localhost" ||
    origin === "http://localhost" ||
    /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(origin);
  const corsOptions: cors.CorsOptions = {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (isLocalPreviewOrigin(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // BF_SERVER_BLOCK_v639_CORS_MAYA_AUDIENCE_v1 — portal sends X-Maya-Audience
    // (staff|client|visitor) on every Maya call. Without it in the allowlist the
    // browser blocks the preflight with "Request header field x-maya-audience
    // is not allowed by Access-Control-Allow-Headers" — visible in console of
    // shot_4_48_11 of Todd's BI silo. v638 also wires the proxy to forward it.
    allowedHeaders: ["Content-Type", "Authorization", "x-silo", "X-Request-Id", "x-maya-audience"],
    credentials: true,
    // v758 — cache preflights for 24h so browsers stop re-preflighting every
    // cross-origin call (HAR showed ~1 OPTIONS per request, doubling traffic).
    maxAge: 86400,
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
          "wss://server.boreal.financial",
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
  // BF_SERVER_BLOCK_v661 — bulletproof OTP preflight. The browser OPTIONS
  // preflight for /api/auth/* must always resolve fast with the CORS
  // headers cors() already set, before any downstream middleware. Without
  // this, a racing credentialed preflight from the login page can wedge
  // pending and the login UI sticks on "Sending...".
  app.options(/^\/api\/auth\//, cors(corsOptions), (_req, res) => { res.sendStatus(204); });

  // BF_SERVER_EMAIL_HARDENING_v1 - capture exact raw request bytes so webhook
  // signature verification (SendGrid ECDSA) runs over the true payload. The
  // global json parser consumes the stream before router-level express.raw
  // sees it, so without this the webhook verifies re-serialized JSON (wrong bytes).
  app.use(express.json({ limit: "10mb", verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; } }));
  app.use(cookieParser());

  /**
   * HEALTH (MUST NOT BE CAUGHT BY FRONTEND)
   */
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // BF_SERVER_BLOCK_v653_ROOT_HANDLER_v1 — Azure App Service Linux's
  // default Health Check probe path is "/" when the operator enables
  // Health check in App Service > Configuration > General Settings but
  // leaves the path field on default. Without this handler GET / falls
  // through Express's catch-all and returns 404, every Azure probe
  // fails, the instance is marked Degraded, and after the consecutive-
  // failure threshold Azure silently recycles the container without
  // an exit signal — which matches the observed 2-9 minute restart
  // cadence in /home/LogFiles (same instance ID restarting). Same fix
  // and reasoning as BI_SERVER_BLOCK_v376_AZURE_HEALTH_AND_BOOT_v1.
  app.get("/", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "bf-server",
      build: process.env.BUILD_TAG || "unknown",
      sha: (process.env.COMMIT_SHA || "unknown").slice(0, 8),
      uptime_s: Math.round(process.uptime()),
      ts: new Date().toISOString(),
    });
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
