import crypto from "crypto";
import express from "express";
import helmet from "helmet";

import { corsMiddleware } from "./middleware/cors";
import authRouter from "./routes/auth";
import voiceRouter from "./routes/voice";
import publicRouter from "./routes/public";
import { registerApiRouteMounts } from "./routes/routeRegistry";
import { fail } from "./lib/response";
import { getEnv } from "./config/env";
import routeAlias from "./middleware/routeAlias";
import { deps } from "./system/deps";

const allowedProductionHosts: string[] = ["server.boreal.financial"];

function voiceStatusHandler(req: express.Request, res: express.Response) {
  return res.status(200).json({ status: "ok", data: {}, rid: (req as any).rid });
}

async function callStartHandler(req: express.Request, res: express.Response) {
  const { to } = req.body as { to?: unknown };

  if (!to || typeof to !== "string") {
    return res.status(400).json({ status: "error", error: "invalid_payload", rid: (req as any).rid });
  }

  try {
    return res.status(200).json({
      status: "ok",
      data: { callId: `call_${Date.now()}`, status: "queued" },
      rid: (req as any).rid,
    });
  } catch {
    return res.status(500).json({ status: "error", error: "call_start_failed", rid: (req as any).rid });
  }
}

export function createApp() {
  const app = express();

  app.use((req, res, next) => {
    const id = crypto.randomUUID();
    (req as any).rid = id;
    (req as any).id = id;
    res.setHeader("x-request-id", id);
    deps.metrics.requests += 1;

    res.on("finish", () => {
      const entry = {
        level: "info",
        msg: "request",
        method: req.method,
        path: req.path,
        status: res.statusCode,
        rid: id,
      };
      try {
        console.log(JSON.stringify(entry));
      } catch {
        // no-op logging fallback
      }

      if (res.statusCode >= 400) {
        deps.metrics.errors += 1;
      }
    });

    next();
  });

  app.get("/health", (req, res) => {
    return res.status(200).json({ status: "ok", data: {}, rid: (req as any).rid });
  });

  app.get("/ready", (req, res) => {
    if (!deps.db.ready) {
      return res.status(503).json({ status: "error", error: "not_ready", rid: (req as any).rid });
    }
    return res.status(200).json({ status: "ok", data: {}, rid: (req as any).rid });
  });

  app.get("/api/_int/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
    });
  });

  app.use((req, res, next) => {
    if (
      req.path === "/" ||
      req.path === "/health" ||
      req.path === "/ready" ||
      req.path === "/metrics" ||
      req.path === "/api/_int/health"
    ) {
      return next();
    }

    const raw = req.headers.host || "";
    const normalized = raw.split(":")[0];
    const { NODE_ENV } = getEnv();

    if (NODE_ENV !== "production") {
      if (normalized === "localhost" || normalized === "127.0.0.1") {
        return next();
      }
    }

    if (!allowedProductionHosts.includes(normalized)) {
      return res.status(403).send("Forbidden");
    }

    return next();
  });

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(express.json());
  app.use(corsMiddleware);

  app.use(routeAlias);

  app.get("/", (_req, res) => {
    res.status(200).send("OK");
  });

  const apiHealthHandler = (req: any, res: any) => {
    const skipDb = process.env.SKIP_DB_CONNECTION === "true";
    if (!deps.db.ready && !skipDb) {
      return res.status(503).json({ status: "error", error: { message: "DB_UNAVAILABLE" }, rid: req.rid });
    }

    return res.status(200).json({
      status: "ok",
      data: {
        server: "ok",
        db: deps.db.ready ? "ok" : "degraded",
        twilio: process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE ? "configured" : "missing",
      },
      rid: req.rid,
    });
  };

  app.get("/api/health", apiHealthHandler);
  app.get("/api/v1/health", apiHealthHandler);

  app.get("/metrics", (req, res) => {
    return res.status(200).json({
      status: "ok",
      data: {
        requests: deps.metrics.requests,
        errors: deps.metrics.errors,
      },
      rid: (req as any).rid,
    });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/v1/auth", authRouter);

  app.use("/api/voice", voiceRouter);
  app.use("/api/v1/voice", voiceRouter);
  app.post("/api/voice/status", voiceStatusHandler);
  app.post("/api/v1/voice/status", voiceStatusHandler);

  app.post("/api/call/start", callStartHandler);
  app.post("/api/v1/call/start", callStartHandler);

  {
    let windowStart = 0;
    let count = 0;

    const publicTestLimiter = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method.toUpperCase() !== "GET" || req.path !== "/") {
        return next();
      }

      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        count = 0;
      }

      count += 1;
      if (count > 100) {
        res.setHeader("retry-after", "1");
        return res.status(429).json({ status: "error", error: "Too many requests", rid: (req as any).rid });
      }

      return next();
    };

    app.use("/api/v1/public/test", publicTestLimiter);
    app.use("/api/v1/public", publicRouter);
  }

  registerApiRouteMounts(app);

  app.use((req: any, res) => {
    return res.status(404).json(fail("not_found", req.rid));
  });

  return app;
}

export const app = createApp();

export function resetOtpStateForTests() {
  // OTP persistence is external/no-op for this router.
}
