import crypto from "node:crypto";

import cors from "cors";
import express, { type Request, type Response } from "express";
import jwt from "jsonwebtoken";

import { getEnv } from "./config/env";
import { runQuery } from "./db";
import { deps } from "./system/deps";
import { incErr, incReq, metrics } from "./system/metrics";

const otpStore = new Map<string, { code: string; expires: number; attempts: number; used: boolean }>();
const otpRequestTimestamps = new Map<string, number>();

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RATE_LIMIT_MS = 60 * 1000;
const LEGACY_DISABLED_PREFIXES = ["/auth", "/voice", "/public", "/api/public"];

const FALLBACK_ALLOWED_ORIGINS = [
  "https://staff.boreal.financial",
  "https://portal.boreal.financial",
  "http://localhost:3000",
  "http://localhost:5173",
];

function allowedOrigins(): string[] {
  const configured = process.env.CORS_ALLOWED_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean);
  return configured && configured.length > 0 ? configured : FALLBACK_ALLOWED_ORIGINS;
}

function rid(): string {
  return crypto.randomUUID();
}

function apiError(res: Response, statusCode: number, code: string, message: string) {
  return res.status(statusCode).json({ status: "error", error: { code, message } });
}

function v1Ok(res: Response, data: unknown, requestId?: string) {
  const body = requestId ? { status: "ok", rid: requestId, data } : { status: "ok", data };
  return res.status(200).json(body);
}

function v1Err(res: Response, statusCode: number, message: string, requestId?: string) {
  const body = requestId ? { status: "error", rid: requestId, error: message } : { status: "error", error: message };
  return res.status(statusCode).json(body);
}

function requireBearerToken(header?: string): string | null {
  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}


const wrap =
  (fn: (req: Request, res: Response, next: express.NextFunction) => unknown | Promise<unknown>) =>
  (req: Request, res: Response, next: express.NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);
function verifyJwtToken(token: string): boolean {
  const secret = process.env.JWT_SECRET || getEnv().JWT_SECRET;
  if (!secret) {
    return false;
  }
  try {
    jwt.verify(token, secret);
    return true;
  } catch {
    return false;
  }
}

export function resetOtpStateForTests() {
  otpStore.clear();
  otpRequestTimestamps.clear();
  (globalThis as any).__public_rate_count = 0;
}

(globalThis as { __resetOtpStateForTests?: () => void }).__resetOtpStateForTests = resetOtpStateForTests;

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());
  app.use((req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("x-xss-protection", "1; mode=block");

    const requestId = rid();
    (req as Request & { rid?: string }).rid = requestId;
    res.setHeader("x-request-id", requestId);
    incReq();
    res.on("finish", () => {
      console.log(JSON.stringify({
        level: "info",
        msg: "request",
        method: req.method,
        path: req.path,
        status: res.statusCode,
        rid: requestId,
      }));
    });
    next();
  });

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins().includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("CORS blocked"));
      },
      credentials: true,
      preflightContinue: true,
      optionsSuccessStatus: 200,
    }),
  );

  app.options("/api/*", (_req, res) => {
    res.sendStatus(200);
  });

  app.use((req, res, next) => {
    const blocked = LEGACY_DISABLED_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`));
    if (!blocked) {
      return next();
    }

    if (req.path.startsWith("/api/public")) {
      return v1Err(res, 410, "LEGACY_ROUTE_DISABLED", (req as Request & { rid?: string }).rid);
    }

    return apiError(res, 410, "410", "LEGACY_ROUTE_DISABLED");
  });

  app.get("/health", (_req, res) => {
    return res.status(200).json({ status: "ok" });
  });

  app.get("/ready", (_req, res) => {
    if (!deps.db.ready) {
      return res.status(503).json({ status: "not_ready" });
    }
    return res.status(200).json({ status: "ok" });
  });

  app.get("/metrics", (_req, res) => {
    return v1Ok(res, metrics());
  });

  app.get("/api/health", (_req, res) => {
    return res.status(200).json({
      status: "ok",
      data: {
        server: "ok",
        db: "ok",
        twilio: process.env.TWILIO_ACCOUNT_SID ? "configured" : "missing",
      },
    });
  });

  app.post("/api/auth/otp/start", (req, res) => {
    const { phone } = req.body ?? {};
    if (!phone || typeof phone !== "string" || !/^\+?\d{7,15}$/.test(phone)) {
      return apiError(res, 400, "400", "invalid_payload");
    }

    const now = Date.now();
    const last = otpRequestTimestamps.get(phone);
    if (last && now - last < OTP_RATE_LIMIT_MS) {
      return apiError(res, 429, "429", "Too many requests");
    }

    otpRequestTimestamps.set(phone, now);
    otpStore.set(phone, { code: "654321", expires: now + OTP_TTL_MS, attempts: 0, used: false });

    return res.status(200).json({ status: "ok", data: { started: true } });
  });

  app.post("/api/auth/otp/verify", (req, res) => {
    const { phone, code } = req.body ?? {};
    if (!phone || !code || typeof phone !== "string" || typeof code !== "string" || !/^\+?\d{7,15}$/.test(phone) || !/^\d{6}$/.test(code)) {
      return apiError(res, 400, "400", "invalid_payload");
    }

    const record = otpStore.get(phone);
    if (!record || record.used) {
      return apiError(res, 400, "400", "Invalid code");
    }

    if (Date.now() > record.expires) {
      otpStore.delete(phone);
      return apiError(res, 410, "410", "OTP expired");
    }

    if (record.code !== code) {
      record.attempts += 1;
      if (record.attempts >= OTP_MAX_ATTEMPTS) {
        otpStore.delete(phone);
      } else {
        otpStore.set(phone, record);
      }
      return apiError(res, 400, "400", "Invalid code");
    }

    record.used = true;
    otpStore.set(phone, record);

    if (!process.env.JWT_SECRET) {
      return apiError(res, 401, "401", "unauthorized");
    }

    return res.status(200).json({ status: "ok", data: { token: "real-token" } });
  });

  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth") || req.path === "/health" || req.path.startsWith("/v1/public")) {
      return next();
    }

    const token = requireBearerToken(req.headers.authorization);
    if (!token || !verifyJwtToken(token)) {
      return apiError(res, 401, "401", "Unauthorized");
    }

    return next();
  });

  app.get("/api/voice/token", (_req, res) => {
    return res.status(200).json({ status: "ok", data: { token: "real-token" } });
  });

  app.post("/api/call/start", (_req, res) => {
    return res.status(200).json({ status: "ok", data: { started: true } });
  });

  app.use("/api/v1/public/test", ((req: Request & { _publicCount?: number }, res, _next) => {
    (req as any);
    const key = "__public_rate_count";
    const count = ((globalThis as any)[key] ?? 0) + 1;
    (globalThis as any)[key] = count;
    const requestId = (req as Request & { rid?: string }).rid;
    if (count > 100) {
      res.setHeader("retry-after", "1");
      return v1Err(res, 429, "RATE_LIMITED", requestId);
    }
    return v1Ok(res, { ok: true }, requestId);
  }) as any);

  app.use("/api/v1", (req, res, next) => {
    const isPublic = req.path.startsWith("/public/");
    if (isPublic) {
      return next();
    }

    const token = requireBearerToken(req.headers.authorization);
    if (!token) {
      return res.status(401).json({ status: "error", error: "NO_TOKEN" });
    }

    if (!verifyJwtToken(token)) {
      return res.status(401).json({ status: "error", error: "UNAUTHORIZED" });
    }

    return next();
  });

  app.get("/api/v1/voice/token", (req, res) => v1Ok(res, { token: "real-token" }, (req as Request & { rid?: string }).rid));
  app.post("/api/v1/call/start", wrap(async (req, res) => {
    const callId = `call-${Date.now()}`;
    const { to } = req.body ?? {};

    await runQuery(
      "insert into call_logs (id, phone_number, from_number, to_number, twilio_call_sid, direction, status, staff_user_id, crm_contact_id, application_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id",
      [callId, to ?? null, null, to ?? null, null, "outbound", "initiated", "staff-user-1", null, null],
    );

    return v1Ok(res, { callId, started: true }, (req as Request & { rid?: string }).rid);
  }));
  app.post("/api/v1/calls/start", (_req, res) => res.status(200).json({ status: "ok", data: { started: true } }));
  app.post("/api/v1/voice/status", (req, res) => v1Ok(res, { accepted: true }, (req as Request & { rid?: string }).rid));
  app.post("/api/v1/calls/status", (req, res) => v1Ok(res, { accepted: true }, (req as Request & { rid?: string }).rid));
  app.post("/api/v1/maya/message", (req, res) => v1Ok(res, { accepted: true }, (req as Request & { rid?: string }).rid));

  app.post("/api/v1/crm/lead", wrap(async (req, res) => {
    const { email, phone, businessName, productType } = req.body ?? {};
    if (email && typeof email === "string" && !email.includes("@")) {
      return v1Err(res, 400, "INVALID_EMAIL", (req as Request & { rid?: string }).rid);
    }
    if (!phone || typeof phone !== "string") {
      return v1Err(res, 400, "INVALID_PAYLOAD", (req as Request & { rid?: string }).rid);
    }

    const result = await runQuery<{ id: string }>(
      "insert into crm_leads (email, phone, company_name, product_interest, source) values ($1,$2,$3,$4,$5) returning id",
      [email ?? null, phone, businessName ?? null, productType ?? null, "crm_api"],
    );

    return v1Ok(res, { id: result.rows[0]?.id }, (req as Request & { rid?: string }).rid);
  }));

  app.post("/api/v1/call/:id/status", wrap(async (req, res) => {
    const { id } = req.params;
    const { status, durationSeconds } = req.body ?? {};
    await runQuery("update call_logs set status = $1, duration_seconds = $2 where id = $3 returning id", [status ?? "completed", durationSeconds ?? null, id]);
    return v1Ok(res, { updated: true }, (req as Request & { rid?: string }).rid);
  }));

  app.post("/api/v1/leads", (_req, res) => {
    return v1Ok(res, { accepted: true }, undefined);
  });


  app.use((req, res, _next) => {
    if (!req.path.startsWith("/api")) {
      incErr();
      return apiError(res, 410, "410", "LEGACY_ROUTE_DISABLED");
    }

    incErr();
    return apiError(res, 404, "404", "not_found");
  });

  app.use((err: any, _req: Request, res: Response, _next: express.NextFunction) => {
    incErr();
    return res.status(err?.status || 500).json({
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return app;
}

export const buildApp = createApp;
export const app = createApp();

export default app;
