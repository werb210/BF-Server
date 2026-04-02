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
import readyRouter from "./routes/ready";

declare global {
  // eslint-disable-next-line no-var
  var __resetOtpStateForTests: (() => void) | undefined;
}

export function resetOtpStateForTests() {}

globalThis.__resetOtpStateForTests = resetOtpStateForTests;

function registerApiRoutes(app: express.Express) {
  process.env.STRICT_API = CONFIG.STRICT_API;

  app.use(requestContext);
  app.use(corsMiddleware);
  app.use(express.json({ limit: "2mb" }));

  app.use((req, res, next) => {
    const originalJson = res.json;

    res.json = function (body) {
      if (!body || typeof body !== "object" || !("status" in body)) {
        console.error("INVALID RESPONSE SHAPE:", body);
      }
      return originalJson.call(this, body);
    };

    next();
  });

  app.use(access());
  app.use((req, _res, next) => {
    incReq();
    next();
  });
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

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    next();
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
  app.use("/", twilioRoutes);

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

  app.use((req, res) => {
    if (!res.headersSent && !res.locals.__wrapped) {
      return fail(res, "Unwrapped response", 500);
    }
    return undefined;
  });

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

  // SINGLE shared reference used everywhere
  app.locals.deps = deps;
  Object.defineProperty(app.locals, "deps", {
    writable: false,
    configurable: false,
  });

  // register routes AFTER deps is attached
  app.use("/health", healthRouter);
  app.use("/ready", readyRouter);

  registerApiRoutes(app);

  return app;
}

export async function buildApp() {
  return createApp(defaultDeps);
}

export const buildAppWithApiRoutes = createApp;

export const app = createApp(defaultDeps);

export default app;
