import cors, { type CorsOptions } from "cors";
import express, { type NextFunction, type Request, type Response } from "express";

import authRoutes from "../modules/auth/auth.routes";
import telephonyRoutes from "../routes/telephony.routes";
import { send } from "../utils/contractResponse";

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
    "https://portal.boreal.financial",
    ...(process.env.CORS_ALLOWED_ORIGINS
      ? process.env.CORS_ALLOWED_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean)
      : []),
  ];

  const corsOptions: CorsOptions = {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 200,
  };

  app.use(cors(corsOptions));
  app.options(/.*/, cors(corsOptions));
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => send.ok(res));

  app.use("/auth", authRoutes);
  app.use("/telephony", telephonyRoutes);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === "validation") {
      return send.error(res, 400, "invalid_payload");
    }

    console.error(err);
    return send.error(res, 500, "internal_error");
  });

  app.use((req: Request, res: Response) => {
    console.warn(`404 ROUTE: ${req.method} ${req.path}`);
    return res.status(404).json({
      error: "not_found",
    });
  });

  return app;
}
