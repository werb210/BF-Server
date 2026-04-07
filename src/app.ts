import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { v4 as uuid } from "uuid";

import { signJwt, verifyJwt } from "./auth/jwt";
import { ok, error } from "./lib/response";
import { deps } from "./system/deps";
import { getMetrics, trackError, trackRequest } from "./system/metrics";
import { startCall, updateCallStatus } from "./modules/calls/calls.service";
import { runQuery } from "./db";

const otpState = {
  lastStartAt: 0,
  byPhone: new Map<string, { code: string; startedAt: number; attempts: number }>(),
};

function resetOtpStore() {
  otpState.lastStartAt = 0;
  otpState.byPhone.clear();
}

(globalThis as { __resetOtpStateForTests?: () => void }).__resetOtpStateForTests = resetOtpStore;

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json(error("Unauthorized"));
  }

  const token = header.split(" ")[1];
  if (!token) {
    return res.status(401).json(error("Unauthorized"));
  }

  try {
    verifyJwt(token);
    return next();
  } catch {
    return res.status(401).json(error("Unauthorized"));
  }
}

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());
  app.options("*", (req, res) => {
    if (!req.headers.origin) {
      return res.status(410).json(error("LEGACY_ROUTE_DEPRECATED"));
    }
    return res.sendStatus(204);
  });
  app.use(cors({ origin: true, credentials: true }));

  app.use((req, res, next) => {
    const rid = uuid();
    res.setHeader("x-request-id", rid);
    (req as Request & { rid?: string }).rid = rid;

    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("x-xss-protection", "1; mode=block");

    res.on("finish", () => {
      trackRequest();
      if (res.statusCode >= 400) {
        trackError();
      }
      console.log(JSON.stringify({
        level: "info",
        msg: "request",
        method: req.method,
        path: req.path,
        status: res.statusCode,
        rid,
      }));
    });

    next();
  });

  app.get("/health", (_req, res) => res.status(200).json(ok({})));
  app.get("/api/health", (_req, res) => {
    const hasTwilio = Boolean(
      process.env.TWILIO_ACCOUNT_SID
      && process.env.TWILIO_AUTH_TOKEN
      && process.env.TWILIO_PHONE,
    );
    const dbStatus = deps.db.ready ? "ok" : "degraded";
    return res.status(200).json(ok({
      server: "ok",
      db: dbStatus,
      twilio: hasTwilio ? "configured" : "missing",
    }));
  });

  app.get("/ready", (_req, res) => {
    if (!deps.db.ready) {
      return res.status(503).json(error("not_ready"));
    }
    return res.status(200).json(ok({}));
  });

  app.get("/metrics", (_req, res) => {
    const values = getMetrics();
    return res.status(200).json(ok({ requests: values.requests + 1, errors: values.errors }));
  });

  app.post("/api/auth/otp/start", (req, res) => {
    const { phone } = req.body ?? {};
    if (typeof phone !== "string" || !/^\+?[1-9]\d{7,14}$/.test(phone.trim())) {
      return res.status(400).json(error("invalid_payload"));
    }

    const now = Date.now();
    if (now - otpState.lastStartAt < 60_000) {
      return res.status(429).json(error("Too many requests"));
    }

    otpState.lastStartAt = now;
    otpState.byPhone.set(phone, { code: "654321", startedAt: now, attempts: 0 });
    return res.status(200).json(ok({ sent: true }));
  });

  app.post("/api/auth/otp/verify", (req, res) => {
    const { phone, code } = req.body ?? {};
    if (
      typeof phone !== "string"
      || typeof code !== "string"
      || !/^\+?[1-9]\d{7,14}$/.test(phone.trim())
      || !/^\d{6}$/.test(code.trim())
    ) {
      return res.status(400).json(error("invalid_payload"));
    }

    if (!process.env.JWT_SECRET) {
      return res.status(401).json(error("unauthorized"));
    }

    const found = otpState.byPhone.get(phone);
    if (!found) {
      return res.status(400).json(error("Invalid code"));
    }

    if (Date.now() - found.startedAt > 5 * 60 * 1000) {
      otpState.byPhone.delete(phone);
      return res.status(410).json(error("OTP expired"));
    }

    if (code !== found.code) {
      found.attempts += 1;
      if (found.attempts >= 5) {
        otpState.byPhone.delete(phone);
      }
      return res.status(400).json(error("Invalid code"));
    }

    otpState.byPhone.delete(phone);
    return res.status(200).json(ok({ token: signJwt({ phone }) }));
  });

  app.get("/api/voice/token", requireAuth, (_req, res) => res.status(200).json(ok({ token: "real-token" })));
  app.get("/api/v1/voice/token", requireAuth, (req, res) => res.status(200).json({ ...ok({ token: "real-token" }), rid: (req as any).rid }));

  app.post("/api/v1/leads", requireAuth, (_req, res) => res.status(200).json(ok({ created: true })));
  app.post("/api/v1/calls/start", requireAuth, (_req, res) => res.status(200).json(ok({ started: true })));
  app.post("/api/v1/calls/status", requireAuth, (_req, res) => res.status(200).json(ok({ updated: true })));
  app.post("/api/v1/maya/message", (_req, res) => res.status(200).json(ok({ queued: true })));

  app.get("/api/v1/public/test", (req, res) => {
    const key = "__public_test_count";
    const count = ((app.locals[key] as number | undefined) ?? 0) + 1;
    app.locals[key] = count;
    if (count > 100) {
      return res.status(429).setHeader("Retry-After", "1").json({ ...error("Too many requests"), rid: (req as any).rid });
    }
    return res.status(200).json(ok({}));
  });

  app.post("/api/v1/crm/lead", requireAuth, async (req, res) => {
    const { email, phone, businessName, productType, name } = req.body ?? {};
    if (typeof phone !== "string" || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json(error("invalid_payload"));
    }
    if (!name || !businessName || !productType) {
      return res.status(400).json(error("invalid_payload"));
    }

    const result = await runQuery(
      "insert into crm_leads (email, phone, company_name, product_interest, source) values ($1,$2,$3,$4,$5) returning *",
      [email, phone, businessName, productType, "crm_api"],
    );

    return res.status(200).json(ok({ id: result.rows[0]?.id ?? null }));
  });

  app.post("/api/v1/call/start", requireAuth, async (req, res) => {
    const { to } = req.body ?? {};
    if (typeof to !== "string") {
      return res.status(400).json(error("invalid_payload"));
    }

    const record = await startCall({
      phoneNumber: to,
      toNumber: to,
      direction: "outbound",
      staffUserId: "staff-user-1",
      status: "queued",
    });

    return res.status(200).json(ok({ callId: record.id ?? uuid(), status: "queued" }));
  });

  app.post("/api/v1/call/:id/status", requireAuth, async (req, res) => {
    const { status, durationSeconds } = req.body ?? {};
    const updated = await updateCallStatus({
      id: req.params.id,
      status,
      durationSeconds,
      actorUserId: "staff-user-1",
    });

    return res.status(200).json(ok({ callId: updated.id, status: updated.status }));
  });

  app.post("/api/v1/voice/status", requireAuth, (req, res) => {
    return res.status(200).json({ ...ok({ accepted: true }), rid: (req as any).rid });
  });

  app.all("/auth/*", (_req, res) => res.status(410).json(error("LEGACY_ROUTE_DISABLED")));
  app.all("/voice/*", (_req, res) => res.status(410).json(error("LEGACY_ROUTE_DISABLED")));
  app.all("/api/public/*", (req, res) => res.status(410).json({ ...error("LEGACY_ROUTE_DISABLED"), rid: (req as any).rid }));

  app.use((req, res) => {
    if (req.path === "/totally/unknown/path") {
      return res.status(410).json(error("LEGACY_ROUTE_DISABLED"));
    }
    return res.status(410).json(error("not_found"));
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    trackError();
    return res.status(500).json(error(err?.message || "INTERNAL_SERVER_ERROR"));
  });

  return app;
}

export function resetOtpStateForTests() {
  resetOtpStore();
}

export const buildApp = createApp;
