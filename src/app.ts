import crypto from "crypto";
import express from "express";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

import { listRoutes, printRoutes } from "./debug/printRoutes";
import { requestContext } from "./middleware/requestContext";
import { requestLogger } from "./middleware/requestLogger";
import { requestTimeout } from "./middleware/requestTimeout";
import { routeResolutionLogger } from "./middleware/routeResolutionLogger";
import {
  markNotReady,
  markReady,
} from "./startupState";
import "./startup/envValidation";
import "./services/twilio";
import { PORTAL_ROUTE_REQUIREMENTS, API_ROUTE_MOUNTS } from "./routes/routeRegistry";
import { checkDb } from "./db";
import {
  productionLogger,
  requireHttps,
  securityHeaders,
} from "./middleware/security";
import { apiLimiter } from "./middleware/rateLimit";
import { csrfProtection } from "./middleware/csrfProtection";
import lendersRoutes from "./routes/lenders";
import lenderProductsRoutes from "./routes/lenderProducts";
import applicationsRoutes from "./routes/applications";
import aiRoutes from "./routes/ai";
import readinessRouter from "./routes/readiness";
import contactRouter from "./routes/contact";
import supportRouter from "./routes/support";
import publicRouter from "./routes/public";
import aiCoreRouter from "./routes/aiCore";
import applicationRouter from "./routes/application";
import applicationContinuationRouter from "./modules/continuation/continuation.routes";
import chatRouter from "./modules/ai/chat.routes";
import confidenceRouter from "./modules/ai/confidence.routes";
import twilioRoutes from "./routes/twilio";
import telephonyRoutes from "./routes/telephony";
import { assertApiV1Frozen } from "./contracts/v1Freeze";
import envCheck from "./middleware/envCheck";
import { logger as serverLogger } from "./server/utils/logger";
import { verifyRoutes } from "./startup/verifyRoutes";
import systemHealthRouter from "./routes/systemHealth";
import { httpMetricsMiddleware } from "./metrics/httpMetrics";
import { requestId } from "./platform/requestId";
import { idempotency } from "./platform/idempotency";
import healthRoutes from "./platform/healthRoutes";
import metricsRoutes from "./platform/metricsRoutes";
import { env } from "./platform/env";
import internalEnvRouter from "./routes/internal/env";
import apiRouter from "./routes/api";
import analyticsRouter from "./routes/analytics";
import sessionRoutes from "./routes/session";
import applicationCompatRoutes from "./routes/applicationCompat";
import otpCompatRoutes from "./routes/otpCompat";
import applicationDevRoutes from "./routes/applicationDev";
import { requireAuth, requireAuthorization } from "./middleware/auth";
import { ALL_ROLES } from "./auth/roles";
import recoveryRoutes from "./routes/recoveryRoutes";
import devRecoveryRoutes from "./routes/devRecoveryRoutes";
import devRoutes from "./routes/dev";
import healthRouter from "./routes/health";
import debugDbTestRouter from "./routes/debugDbTest";
import { corsMiddleware } from "./middleware/cors";
import { normalizeApiPath } from "./middleware/normalizeApiPath";
import { dbGuard } from "./middleware/dbGuard";
import { sessionMiddleware } from "./middleware/sessionStore";

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isCompatEnabled(): boolean {
  return isTruthyFlag(process.env.ENABLE_COMPAT_ROUTES);
}

/* ---------------- ROUTE ASSERTION ---------------- */

function assertRoutesMounted(app: express.Express): void {
  const mountedRoutes = listRoutes(app);
  const mountedSet = new Set(
    mountedRoutes.map((route) => `${route.method} ${route.path}`)
  );

  const missing = PORTAL_ROUTE_REQUIREMENTS.filter(
    (route) => !mountedSet.has(`${route.method} ${route.path}`)
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing API routes: ${missing
        .map((route) => `${route.method} ${route.path}`)
        .join(", ")}`
    );
  }
}

/* ---------------- CORS ---------------- */

export function shouldBlockInternalOriginRequest(
  path: string,
  origin?: string
): boolean {
  return (
    Boolean(origin) &&
    (path.startsWith("/api/_int") || path.startsWith("/api/internal"))
  );
}

export function assertCorsConfig(): void {
  const hasAllowedOrigins =
    process.env.CORS_ALLOWED_ORIGINS?.trim().length ||
    process.env.CORS_ALLOWLIST?.trim().length ||
    process.env.CLIENT_ORIGIN?.trim().length ||
    process.env.PORTAL_ORIGIN?.trim().length;

  if (!hasAllowedOrigins) {
    throw new Error(
      "CORS_ALLOWED_ORIGINS (or CORS_ALLOWLIST) must include at least one origin."
    );
  }
}

/* ---------------- BUILD APP ---------------- */

export function buildApp(): express.Express {
  const app = express();
  app.set("trust proxy", true);

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  app.use("/health", healthRouter);

  app.use((req, _res, next) => {
    const forwardedHost = req.headers["x-forwarded-host"];
    const proto = req.headers["x-forwarded-proto"];

    if (typeof forwardedHost === "string" && forwardedHost.length > 0) {
      req.headers.host = forwardedHost;
    }

    if (typeof proto === "string" && proto.length > 0) {
      Object.defineProperty(req, "protocol", {
        value: proto,
        configurable: true,
      });
    }

    next();
  });

  app.use(normalizeApiPath);

  app.use((req, _res, next) => {
    req.id = String(req.headers["x-request-id"] || crypto.randomUUID());
    next();
  });

  app.use(requestId);
  app.use(requestLogger);
  app.use(httpMetricsMiddleware);
  app.use(requestContext);
  app.use(productionLogger);

  app.use(corsMiddleware);
  app.use(sessionMiddleware);

  app.use(helmet());

  app.use(securityHeaders);
  app.use(csrfProtection);
  app.use("/api/", apiLimiter);
  app.use(routeResolutionLogger);
  app.use((req, _res, next) => {
    if (req.url.startsWith("/telephony/")) {
      req.url = req.url.replace("/telephony", "/api/telephony");
    }
    next();
  });
  if (isTruthyFlag(process.env.ENABLE_RECOVERY_ROUTES)) {
    serverLogger.warn("recovery_routes_enabled");
    app.use(recoveryRoutes);
  }
  if (env.NODE_ENV === "development") {
    app.use(devRecoveryRoutes);
  }
  app.use((req, _res, next) => {
    if (req.path.includes("verify-otp")) {
      req.log?.info({
        event: "otp_request_received",
        body: req.body,
      });
    }
    next();
  });

  app.use(requestTimeout);

  return app;
}

/* ---------------- INIT ---------------- */

export async function initializeServer(): Promise<void> {
  markNotReady("initializing");
  await checkDb();
  markReady();
}

/* ---------------- REGISTER ROUTES ---------------- */

export function registerApiRoutes(app: express.Express): void {
  assertApiV1Frozen();
  app.use(envCheck);
  app.use(requireHttps);
  app.use(devRoutes);

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  });

  const continuationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  });

  app.use("/api", limiter);
  app.use("/api/client", requireHttps);
  app.use(idempotency);

  app.get("/api", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use("/health", healthRoutes);
  app.use(metricsRoutes);
  app.use("/api/health", healthRoutes);
  app.use("/api", healthRoutes);
  app.get("/_int/health", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/_int/runtime", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/api/_int/health", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/api/_int/runtime", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/api/ready", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use(sessionRoutes);
  if (isCompatEnabled()) {
    serverLogger.warn("compat_routes_enabled");
    app.use(applicationCompatRoutes);
    app.use(otpCompatRoutes);
  }
  app.use("/api", systemHealthRouter);
  app.use("/api/debug", debugDbTestRouter);
  app.use("/api", dbGuard);
  app.use("/api/readiness", readinessRouter);
  app.use("/api/contact", contactRouter);
  app.use("/api", chatRouter);
  app.use("/api", confidenceRouter);
  app.use("/api/public", publicRouter);
  app.use("/api/support", supportRouter);
  app.use("/api/application", applicationDevRoutes);
  app.use("/api", aiCoreRouter);
  app.use("/api/telephony", requireAuth, requireAuthorization({ roles: ALL_ROLES }), telephonyRoutes);
  app.use("/api", twilioRoutes);
  app.use("/api", apiRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/application", requireAuth, requireAuthorization({ roles: ALL_ROLES }), applicationRouter);
  app.use("/api/application/continuation", continuationLimiter, applicationContinuationRouter);

  /* Explicit mounts */
  app.use("/api/lenders", lendersRoutes);
  app.use("/api/lender-products", lenderProductsRoutes);
  app.use("/api/applications", applicationsRoutes);
  app.use("/api/ai", aiRoutes);
  app.use(internalEnvRouter);

  /* Dynamic mounts — REQUIRED FOR TESTS */
  API_ROUTE_MOUNTS.forEach((entry) => {
    if (entry.path === "/dashboard") {
      app.use(`/api${entry.path}`, requireAuth, requireAuthorization({ roles: ALL_ROLES }), entry.router);
      return;
    }

    app.use(`/api${entry.path}`, entry.router);
  });


  app.get("/continuation/session", (req, res) => {
    req.url = "/api/application/continuation";
    (app as any).handle(req, res);
  });

  app.use("/api/*", (_req, res) => {
    res.status(404).json({
      code: "not_found",
      error: "not_found",
      message: "API route not found",
      requestId: _req.id ?? "unknown",
    });
  });

  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const status = typeof err?.status === "number" ? err.status : 500;
    const code = typeof err?.code === "string" ? err.code : "internal_error";
    const message = typeof err?.message === "string" && err.message.length > 0 ? err.message : "Unexpected error";
    res.status(status).json({
      code,
      error: code,
      message,
      requestId: req.id || "unknown",
    });
  });

  const mountedRoutes = listRoutes(app);
  printRoutes(app);

  if (env.NODE_ENV === "development" && env.PRINT_ROUTES === "true") {
    serverLogger.info("mounted_routes", {
      routes: mountedRoutes.map((route) => `${route.method} ${route.path}`),
    });
  }

  assertRoutesMounted(app);
  verifyRoutes(app);
}

/* ---------------- BOOTSTRAP ---------------- */

export function buildAppWithApiRoutes(): express.Express {
  const app = buildApp();
  registerApiRoutes(app);
  return app;
}

const app = buildAppWithApiRoutes();

export default app;

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION", err);
});
