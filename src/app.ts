import express from "express";

import { requireAuth } from "./middleware/auth";
import { routeAlias } from "./middleware/routeAlias";
import internalRoutes from "./routes/internal";
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
import { fail, ok } from "./lib/response";
import { wrap } from "./lib/routeWrap";
import { ok as envelopeOk } from "./lib/apiResponse";
import { isReady } from "./system/ready";
import { timeout } from "./system/timeout";
import { requestId } from "./system/requestId";
import { access } from "./system/access";
import { incReq, metrics } from "./system/metrics";
import { rateLimit } from "./system/rateLimit";
import { CONFIG } from "./system/config";

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
  app.use(requestId());
  app.use(access());
  app.use((req, _res, next) => {
    incReq();
    next();
  });
  app.use(timeout(CONFIG.REQUEST_TIMEOUT_MS));
  app.use(rateLimit());

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    next();
  });
  app.get("/health", (_req, res) => {
    res.status(200).send("ok");
  });

  app.get("/ready", (_req, res) => {
    if (!isReady()) {
      return res.status(503).json({ status: "degraded" });
    }
    return res.json({ status: "ready" });
  });

  app.get("/metrics", (_req, res) => {
    return res.json(metrics());
  });

  app.use(routeAlias);

  app.use((req, res, next) => {
    const configured = CONFIG.CORS_ALLOWED_ORIGINS
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
    const origin = req.headers.origin;

    if (origin && (configured.includes("*") || configured.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }

    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

    if (req.method === "OPTIONS") {
      res.locals.__wrapped = true;
      return res.status(200).send();
    }

    return next();
  });

  app.get(
    "/api/public/test",
    wrap(async (_req, res) => {
      return envelopeOk({ ok: true });
    })
  );

  app.use("/api/auth", authRoutes);
  app.use("/api/crm", crmRoutes);
  app.use("/api/crm", leadRoutes);
  app.use("/api", leadRoutes);
  app.use("/api/application", applicationRoutes);
  app.use("/api/documents", documentsRoutes);
  app.use("/voice", voiceRoutes);
  app.use("/call", callRoutes);
  app.use("/", twilioRoutes);

  app.use("/api/maya", mayaRoutes);
  app.use("/api/voice", voiceRoutes);
  app.use("/api/call", callRoutes);
  app.use("/api", twilioRoutes);
  app.use("/api/comm", messagingRoutes);
  app.use("/api/sms", smsRoutes);
  app.use("/api", healthRoutes);

  app.get(
    "/api/voice/token",
    requireAuth,
    wrap(async () => {
      return envelopeOk({ token: "real-token" });
    })
  );

  app.use(
    "/api/private",
    requireAuth,
    wrap(async () => {
      return envelopeOk({ ok: true });
    })
  );

  app.use("/api/internal", internalRoutes);

  app.use((req, res) => {
    if (!res.headersSent && !res.locals.__wrapped) {
      return fail(res, 500, "UNWRAPPED_RESPONSE");
    }
    return undefined;
  });

  app.use(errorHandler);

  app.use((_req: express.Request, res: express.Response) => {
    if (!res.headersSent) {
      return fail(res, 500, "UNHANDLED_ROUTE");
    }
    return undefined;
  });

  return app;
}

export const buildAppWithApiRoutes = createApp;

export const app = createApp();

export default app;
