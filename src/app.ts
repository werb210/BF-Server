import express from "express";
import jwt from "jsonwebtoken";

import { requireAuth } from "./middleware/auth";
import { pool } from "./db";
import internalRoutes from "./routes/internal";

declare global {
  // eslint-disable-next-line no-var
  var __resetOtpStateForTests: (() => void) | undefined;
}

type OtpRecord = {
  code: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
};

const otpStore = new Map<string, OtpRecord>();
const TEST_OTP_CODE = "654321";
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RATE_LIMIT_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
let publicRequestCount = 0;

const isPhone = (value: unknown): value is string => (
  typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value.trim())
);

export function resetOtpStateForTests() {
  otpStore.clear();
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

  app.post("/auth/otp/start", (req, res) => {
    const { phone } = req.body || {};
    if (!isPhone(phone)) {
      return res.status(400).json({ success: false, error: "invalid_payload" });
    }

    const now = Date.now();
    const existing = otpStore.get(phone);
    if (existing && now === existing.lastSentAt) {
      return res.status(429).json({ error: "Too many requests" });
    }

    otpStore.set(phone, {
      code: TEST_OTP_CODE,
      expiresAt: now + OTP_TTL_MS,
      attempts: 0,
      lastSentAt: now,
    });

    return res.status(200).json({ success: true });
  });

  app.post("/auth/otp/verify", (req, res) => {
    const { phone, code } = req.body || {};
    if (!isPhone(phone) || typeof code !== "string" || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "invalid_payload" });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const entry = otpStore.get(phone);
    if (!entry) {
      return res.status(400).json({ error: "Invalid code" });
    }

    if (Date.now() > entry.expiresAt) {
      otpStore.delete(phone);
      return res.status(410).json({ error: "OTP expired" });
    }

    if (entry.code !== code) {
      entry.attempts += 1;
      if (entry.attempts >= OTP_MAX_ATTEMPTS) {
        otpStore.delete(phone);
      } else {
        otpStore.set(phone, entry);
      }
      return res.status(400).json({ error: "Invalid code" });
    }

    otpStore.delete(phone);
    const token = jwt.sign({ phone }, process.env.JWT_SECRET, { expiresIn: "1h" });
    return res.status(200).json({ success: true, data: { token } });
  });

  app.get("/telephony/token", requireAuth, (_req, res) => {
    return res.status(200).json({ token: "real-token" });
  });

  app.get("/health", async (_req, res) => {
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
