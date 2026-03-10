import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

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
import { notFoundHandler } from "./middleware/errors";
import authRoutes from "./routes/auth";
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
import voiceToken from "./routes/voiceToken";
import voiceIncoming from "./routes/voiceIncoming";
import voiceStatusRoute from "./routes/voiceStatus";
import twilioVoice from "./routes/twilioVoice";
import telephonyRoutes from "./telephony/routes/telephonyRoutes";
import { assertApiV1Frozen } from "./contracts/v1Freeze";
import envCheck from "./middleware/envCheck";
import { logger as serverLogger } from "./server/utils/logger";
import { verifyRoutes } from "./startup/verifyRoutes";
import systemHealthRouter from "./routes/systemHealth";
import { httpMetricsMiddleware } from "./metrics/httpMetrics";
import { requestId } from "./platform/requestId";
import { idempotency } from "./platform/idempotency";
import { errorHandler } from "./platform/errorHandler";
import healthRoutes from "./platform/healthRoutes";
import metricsRoutes from "./platform/metricsRoutes";
import { env } from "./platform/env";

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

function getRequiredCorsOrigins(): string[] {
  return [
    env.CLIENT_URL,
    env.PORTAL_URL,
    env.WEBSITE_URL,
  ]
    .map((origin) => (typeof origin === "string" ? origin.trim() : ""))
    .filter((origin) => origin.length > 0);
}

export function shouldBlockInternalOriginRequest(
  path: string,
  origin?: string
): boolean {
  return (
    Boolean(origin) &&
    (path.startsWith("/api/_int") || path.startsWith("/api/internal"))
  );
}

function buildCorsOptions(): cors.CorsOptions {
  const allowlist = new Set(getRequiredCorsOrigins());

  return {
    origin: [...allowlist],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "Idempotency-Key",
      "X-Request-Id",
    ],
    optionsSuccessStatus: 204,
  };
}

export function assertCorsConfig(): void {
  const allowlist = getRequiredCorsOrigins();

  if (allowlist.length === 0) {
    throw new Error(
      "At least one of WEBSITE_URL, PORTAL_URL, or CLIENT_URL must be configured."
    );
  }
}

/* ---------------- BUILD APP ---------------- */

export function buildApp(): express.Express {
  const app = express();

  app.use(requestId);
  app.use(requestLogger);
  app.use(httpMetricsMiddleware);
  app.use(requestContext);
  app.use(productionLogger);

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  const corsOptions = buildCorsOptions();
  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));

  app.use(
    helmet({
      contentSecurityPolicy: false,
    })
  );

  app.use(securityHeaders);
  app.use(csrfProtection);
  app.use("/api/", apiLimiter);
  app.use(routeResolutionLogger);
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

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use("/api", limiter);
  app.use("/api/client", requireHttps);
  app.use(idempotency);

  app.use("/health", healthRoutes);
  app.use(metricsRoutes);
  app.use("/api/health", healthRoutes);
  app.use("/", healthRoutes);
  app.use("/api", healthRoutes);
  app.use("/api", systemHealthRouter);
  app.use("/api/readiness", readinessRouter);
  app.use("/api/contact", contactRouter);
  app.use("/api", chatRouter);
  app.use("/api", confidenceRouter);
  app.use("/api/public", publicRouter);
  app.use("/api/support", supportRouter);
  app.use("/api", aiCoreRouter);
  app.use("/api", twilioRoutes);
  app.use("/api", voiceIncoming);
  app.use("/api", voiceStatusRoute);
  app.use("/api", voiceToken);
  app.use("/api", twilioVoice);
  app.use("/telephony", telephonyRoutes);
  app.use("/api/application", applicationRouter);
  app.use("/api/application/continuation", applicationContinuationRouter);

  /* Explicit mounts */
  app.use("/api/auth", authRoutes);
  app.use("/api/lenders", lendersRoutes);
  app.use("/api/lender-products", lenderProductsRoutes);
  app.use("/api/applications", applicationsRoutes);
  app.use("/api/ai", aiRoutes);

  /* Dynamic mounts — REQUIRED FOR TESTS */
  API_ROUTE_MOUNTS.forEach((entry) => {
    app.use(`/api${entry.path}`, entry.router);
  });

  app.use("/api", notFoundHandler);
  app.use(errorHandler);

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
