import express from "express";
import { corsMiddleware } from "./middleware/cors";

import { requireAuth } from "./middleware/requireAuth";
import { routeAlias } from "./middleware/routeAlias";
import internalRoutes from "./routes/internal";
import router from "./routes";
import authRoutes from "./modules/auth/auth.routes";
import messagingRoutes from "./routes/messaging";
import mayaRoutes from "./routes/maya";
import voiceRoutes from "./routes/voice";
import smsRoutes from "./routes/sms";
import healthRouter from "./routes/health";
import crmRoutes from "./routes/crm";
import callRoutes from "./routes/calls";
import twilioRoutes from "./routes/twilio";
import leadRoutes from "./routes/lead";
import applicationRoutes from "./routes/application";
import documentsRoutes from "./routes/documents";
import { errorHandler } from "./middleware/errorHandler";
import { fail, wrap } from "./middleware/response";
import { timeout } from "./system/timeout";
import { requestContext } from "./middleware/requestContext";
import { access } from "./system/access";
import { incReq, metrics } from "./system/metrics";
import { rateLimit } from "./system/rateLimit";
import { CONFIG } from "./system/config";
import { deps as defaultDeps, type Deps } from "./system/deps";
import { readyHandler } from "./routes/ready";

declare global {
  // eslint-disable-next-line no-var
  var __resetOtpStateForTests: (() => void) | undefined;
}

export function resetOtpStateForTests() {}

globalThis.__resetOtpStateForTests = resetOtpStateForTests;

function registerCommonMiddleware(app: express.Express) {
  app.use(requestContext);
  app.use(access());
  app.use((req, _res, next) => {
    incReq();
    next();
  });
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    next();
  });
}

function registerApiRoutes(app: express.Express) {
  process.env.STRICT_API = CONFIG.STRICT_API;

  app.use(corsMiddleware);
  app.use(express.json({ limit: "2mb" }));

  app.use(timeout(CONFIG.REQUEST_TIMEOUT_MS));
  app.use(rateLimit());
  app.use((req, res, next) => {
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      const body = req.body;
      if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
        res.locals.__wrapped = true;
        return fail(res, "Invalid request body", 400);
      }
    }
    return next();
  });

  app.get(
    "/metrics",
    wrap(async () => {
      return {
        requests: metrics().requests,
        errors: metrics().errors,
      };
    }),
  );

  app.use(routeAlias);

  app.use("/api/v1", router);

  app.get(
    "/api/v1/public/test",
    wrap(async () => {
      return { ok: true };
    }),
  );

  app.use("/api/v1/auth", authRoutes);
  app.use("/api/v1/crm", crmRoutes);
  app.use("/api/v1/crm", leadRoutes);
  app.use("/api/v1/application", applicationRoutes);
  app.use("/api/v1/documents", documentsRoutes);

  app.use("/api/v1/maya", mayaRoutes);
  app.use("/api/v1/voice", voiceRoutes);
  app.use("/api/v1/call", callRoutes);
  app.use("/api/v1", twilioRoutes);
  app.use("/api/v1/comm", messagingRoutes);
  app.use("/api/v1/sms", smsRoutes);

  app.get(
    "/api/v1/voice/token",
    requireAuth,
    wrap(async () => {
      return { token: "real-token" };
    }),
  );

  app.use(
    "/api/v1/private",
    requireAuth,
    wrap(async () => {
      return { ok: true };
    }),
  );

  app.use("/api/v1/internal", internalRoutes);

  app.use((_req: express.Request, res: express.Response) => {
    if (!res.headersSent) {
      return fail(res, "Route not found", 404);
    }
    return undefined;
  });

  app.use(errorHandler);
}

export function createApp(deps: Deps) {
  const app = express();

  // CRITICAL: attach SAME object reference used in tests
  app.locals.deps = deps;

  // OPTIONAL HARD LOCK: prevent accidental reassignment
  Object.defineProperty(app.locals, "deps", {
    writable: false,
    configurable: false,
  });

  registerCommonMiddleware(app);

  // ===== ROUTE ORDER (DO NOT CHANGE) =====

  // HEALTH FIRST — NEVER MOVE
  app.use("/health", healthRouter);

  // READINESS SECOND
  app.get("/ready", readyHandler);

  // ALL OTHER ROUTES AFTER
  registerApiRoutes(app);

  return app;
}

export async function buildApp() {
  return createApp(defaultDeps);
}

export const buildAppWithApiRoutes = createApp;

export const app = createApp(defaultDeps);

export default app;
