import express from "express";
import { corsMiddleware } from "./middleware/cors";

import { requireAuth } from "./middleware/auth";
import { routeAlias } from "./middleware/routeAlias";
import internalRoutes from "./routes/internal";
import router from "./routes";
import authRoutes from "./modules/auth/auth.routes";
import messagingRoutes from "./routes/messaging";
import mayaRoutes from "./routes/maya";
import voiceRoutes from "./routes/voice";
import smsRoutes from "./routes/sms";
import healthRoutes from "./routes/health";
import crmRoutes from "./routes/crm";
import callRoutes from "./routes/calls";
import twilioRoutes from "./routes/twilio";
import leadRoutes from "./routes/lead";
import applicationRoutes from "./routes/application";
import documentsRoutes from "./routes/documents";
import { errorHandler } from "./middleware/errorHandler";
import { fail } from "./utils/http/respond";
import { wrap } from "./lib/routeWrap";
import { timeout } from "./system/timeout";
import { requestId } from "./middleware/requestId";
import { access } from "./system/access";
import { incReq, metrics } from "./system/metrics";
import { rateLimit } from "./system/rateLimit";
import { CONFIG } from "./system/config";
import { deps } from "./system/deps";

declare global {
  // eslint-disable-next-line no-var
  var __resetOtpStateForTests: (() => void) | undefined;
}

export function resetOtpStateForTests() {}

globalThis.__resetOtpStateForTests = resetOtpStateForTests;

export function createApp() {
  process.env.STRICT_API = CONFIG.STRICT_API;

  const app = express();

  app.use(express.json());
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
  app.use(requestId);
  app.use(access());
  app.use((req, _res, next) => {
    incReq();
    next();
  });
  app.use(timeout(CONFIG.REQUEST_TIMEOUT_MS));
  app.use(rateLimit());
  app.use(corsMiddleware);
  app.use((req, res, next) => {
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      const body = req.body;
      if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
        res.locals.__wrapped = true;
        return fail(res, "Invalid request body", 400, "INVALID_REQUEST_BODY");
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
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/ready", (_req, res) => {
    if (!deps.db.ready) {
      return res.status(503).json({ status: "not_ready" });
    }

    res.json({ status: "ok" });
  });

  app.get("/metrics", (_req, res) => {
    res.json({
      requests: metrics().requests,
      errors: metrics().errors,
    });
  });

  app.use(routeAlias);

  app.use("/api/v1", router);

  app.get(
    "/api/v1/public/test",
    wrap(async (_req, _res) => {
      return { ok: true };
    })
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
  app.use("/api/v1", healthRoutes);

  app.get(
    "/api/v1/voice/token",
    requireAuth,
    wrap(async () => {
      return { token: "real-token" };
    })
  );

  app.use(
    "/api/v1/private",
    requireAuth,
    wrap(async () => {
      return { ok: true };
    })
  );

  app.use("/api/v1/internal", internalRoutes);

  app.use((req, res) => {
    if (!res.headersSent && !res.locals.__wrapped) {
      return fail(res, "Unwrapped response", 500, "UNWRAPPED_RESPONSE");
    }
    return undefined;
  });

  app.use((_req: express.Request, res: express.Response) => {
    if (!res.headersSent) {
      return fail(res, "Route not found", 404, "NOT_FOUND");
    }
    return undefined;
  });

  app.use(errorHandler);

  return app;
}

export const buildAppWithApiRoutes = createApp;

export const app = createApp();

export default app;
