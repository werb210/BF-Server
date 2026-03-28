import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";

import authRoutes from "../routes/auth.routes";
import telephonyRoutes from "../routes/telephony.routes";
import { auth } from "../middleware/auth";

const requiredEnv = [
  "JWT_SECRET",
  "REDIS_URL",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE",
] as const;

const hasTwilioCredentials = Boolean(
  process.env.TWILIO_ACCOUNT_SID
  && process.env.TWILIO_AUTH_TOKEN
  && process.env.TWILIO_VOICE_APP_SID
);

const isTwilioEnabled = process.env.ENABLE_TWILIO === undefined
  ? hasTwilioCredentials
  : process.env.ENABLE_TWILIO === "true" && hasTwilioCredentials;

function assertRequiredEnv(): void {
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      throw new Error(`Missing env var: ${key}`);
    }
  }
}

export function createServer() {
  assertRequiredEnv();

  const app = express();

  const allowedOrigins = [
    "https://your-portal-domain",
    "https://your-client-domain",
    "https://staff.boreal.financial",
    "https://client.boreal.financial",
    "https://portal.example.com",
    ...((process.env.CORS_ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean)),
  ];

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  setInterval(() => {
    const used = process.memoryUsage();
    console.log("MEMORY:", {
      rss: `${Math.round(used.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)}MB`,
    });
  }, 60_000).unref();

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    optionsSuccessStatus: 200,
  }));

  app.options("/", (_: Request, res: Response) => res.sendStatus(200));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    return next();
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ success: true, data: { ok: true } });
  });

  app.use("/auth", authRoutes);
  app.use("/api/crm", auth, (_req: Request, res: Response) => res.status(200).json({ success: true, data: { ok: true } }));
  app.use("/api/lenders", auth, (_req: Request, res: Response) => res.status(200).json({ success: true, data: { ok: true } }));
  app.post("/api/applications", auth, (req: Request, res: Response) => {
    return res.status(201).json({
      success: true,
      data: {
        applicationId: crypto.randomUUID(),
        application: req.body ?? {},
      },
    });
  });
  app.post("/api/documents/upload", auth, (req: Request, res: Response) => {
    const { applicationId, category } = req.body as { applicationId?: unknown; category?: unknown };
    if (typeof applicationId !== "string" || typeof category !== "string") {
      return res.status(400).json({ success: false, error: "applicationId and category are required" });
    }

    return res.status(201).json({
      success: true,
      data: { documentId: crypto.randomUUID(), applicationId, category },
    });
  });

  if (isTwilioEnabled) {
    app.use("/telephony", telephonyRoutes);
  } else {
    console.warn("⚠️ Twilio not configured — telephony routes disabled");
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[SERVER ERROR]", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  });

  app.use((_: Request, res: Response) => {
    res.status(404).json({ success: false, error: "not_found" });
  });

  return app;
}
