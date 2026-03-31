import express from "express";

import { requireAuth } from "./middleware/auth";
import { pool } from "./db";
import internalRoutes from "./routes/internal";
import authRoutes from "./routes/auth";
import messagingRoutes from "./routes/messaging";

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
  const app = express();

  app.use(express.json());

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

  app.get("/api/health", requireAuth, (_req, res) => {
    return res.status(200).json({ status: "ok" });
  });

  app.get("/api/public/test", (_req, res) => {
    publicRequestCount += 1;
    if (publicRequestCount > 300) {
      return res.status(429).json({ error: "RATE_LIMITED" });
    }
    return res.status(200).json({ ok: true });
  });

  app.use("/auth", authRoutes);
  app.use("/comm", messagingRoutes);

  app.get("/telephony/token", requireAuth, (_req, res) => {
    return res.status(200).json({ token: "real-token" });
  });

  app.get("/health", async (_req, res) => {
    if (!process.env.TWILIO_VERIFY_SERVICE_SID) {
      return res.status(500).json({ status: "missing_verify_sid" });
    }

    let dbStatus = "ok";

    try {
      await pool.query("SELECT 1");
    } catch {
      dbStatus = "down";
    }

    res.status(200).json({
      api: "ok",
      db: dbStatus,
      timestamp: Date.now(),
    });
  });

  app.use("/api/private", requireAuth, (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/internal", internalRoutes);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof SyntaxError) {
      return res.status(400).json({ error: "INVALID_JSON" });
    }

    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  });

  app.use((_req, res) => {
    res.status(404).json({ success: false, error: "not_found" });
  });

  return app;
}

export const buildAppWithApiRoutes = createApp;

export const app = createApp();

export default createApp;
