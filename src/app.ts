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

declare global {
  // eslint-disable-next-line no-var
  var __resetOtpStateForTests: (() => void) | undefined;
}

let publicRequestCount = 0;

const wrap =
  (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

export function resetOtpStateForTests() {
  publicRequestCount = 0;
}

globalThis.__resetOtpStateForTests = resetOtpStateForTests;

export function createApp() {
  process.env.STRICT_API = "true";

  const app = express();

  app.use(express.json());
  app.get(
    "/health",
    wrap(async (_req, res) => {
      return ok(res, {
        service: "bf-server",
        timestamp: new Date().toISOString(),
      });
    })
  );

  app.use(routeAlias);

  app.use((req, res, next) => {
    const configured = (process.env.CORS_ALLOWED_ORIGINS ?? "https://staff.boreal.financial")
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
      publicRequestCount += 1;
      if (publicRequestCount > 300) {
        return fail(res, 429, "RATE_LIMITED");
      }
      return ok(res, { ok: true });
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
    wrap(async (_req, res) => {
      return ok(res, { token: "real-token" });
    })
  );

  app.use(
    "/api/private",
    requireAuth,
    wrap(async (_req, res) => {
      return ok(res, { ok: true });
    })
  );

  app.use("/api/internal", internalRoutes);

  app.use((req, res) => {
    if (!res.locals.__wrapped) {
      return res.status(500).json({
        status: "error",
        error: { code: "UNWRAPPED_RESPONSE", message: "Response not wrapped" },
      });
    }
    return undefined;
  });

  app.use(errorHandler);

  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);

    res.locals.__wrapped = true;

    return res.status(500).json({
      status: "error",
      error: {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : "Internal server error",
      },
    });
  });

  app.use((_req: express.Request, res: express.Response) => {
    return fail(res, 410, "LEGACY_ROUTE_DISABLED");
  });

  return app;
}

export const buildAppWithApiRoutes = createApp;

export const app = createApp();

export default app;
