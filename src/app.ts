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
import leadRoutes from "./routes/lead";
import applicationRoutes from "./routes/application";
import documentsRoutes from "./routes/documents";
import { errorHandler } from "./middleware/errorHandler";

declare global {
  // eslint-disable-next-line no-var
  var __resetOtpStateForTests: (() => void) | undefined;
}

let publicRequestCount = 0;

export function resetOtpStateForTests() {
  publicRequestCount = 0;
}

globalThis.__resetOtpStateForTests = resetOtpStateForTests;

export function createApp() {
  process.env.STRICT_API = "true";

  const app = express();

  app.use(express.json());
  app.use((req, res, next) => {
    console.log("REQ:", req.method, req.path);
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      console.log("RES:", res.statusCode);
      return originalJson(body);
    }) as typeof res.json;
    next();
  });
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
      return res.status(200).send();
    }

    return next();
  });


  app.get("/api/public/test", (_req, res) => {
    publicRequestCount += 1;
    if (publicRequestCount > 300) {
      return res.status(429).json({ success: false, error: "RATE_LIMITED" });
    }
    return res.status(200).json({ success: true, data: { ok: true } });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/crm", crmRoutes);
  app.use("/api/crm", leadRoutes);
  app.use("/api", leadRoutes);
  app.use("/api/application", applicationRoutes);
  app.use("/api/documents", documentsRoutes);
  app.use("/api/maya", mayaRoutes);
  app.use("/api/voice", voiceRoutes);
  app.use("/api/call", callRoutes);
  app.use("/api/comm", messagingRoutes);
  app.use("/api/sms", smsRoutes);
  app.use("/api", healthRoutes);

  app.get("/api/voice/token", requireAuth, (_req, res) => {
    return res.status(200).json({ success: true, data: { token: "real-token" } });
  });

  app.use("/api/private", requireAuth, (_req, res) => {
    return res.json({ success: true, data: { ok: true } });
  });

  app.use("/api/internal", internalRoutes);

  app.use(errorHandler);

  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: `Route not found: ${req.method} ${req.url}`,
    });
  });

  return app;
}

export const buildAppWithApiRoutes = createApp;

export const app = createApp();

export default createApp;
