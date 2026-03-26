import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";

import authRoutes from "../modules/auth/auth.routes";
import telephonyRoutes from "../routes/telephony.routes";

const requiredEnv = [
  "JWT_SECRET",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_VOICE_APP_SID",
] as const;

function assertRequiredEnv(): void {
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      throw new Error(`Missing env: ${key}`);
    }
  }
}

export function createServer() {
  assertRequiredEnv();

  const app = express();

  const allowedOrigins = [
    "https://staff.boreal.financial",
    "https://client.boreal.financial",
    ...(process.env.CORS_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ];

  app.use(express.json());

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
    res.json({ ok: true });
  });

  app.use("/auth", authRoutes);
  app.use("/telephony", telephonyRoutes);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[SERVER ERROR]", err);
    return res.status(err?.status || 500).json({
      error: "internal_error",
      ...(process.env.NODE_ENV !== "production" && { message: err?.message }),
    });
  });

  app.use((_: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}
