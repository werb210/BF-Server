import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";

import authRoutes from "../routes/auth.routes";
import telephonyRoutes from "../routes/telephony.routes";

const requiredEnv = [
  "JWT_SECRET",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_VERIFY_SERVICE_SID",
] as const;

function assertRequiredEnv(): void {
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      throw new Error(`Missing env: ${key}`);
    }
  }
}

export function createServer() {
  console.log("STEP 1: entering createServer");
  console.log("STEP 2: checking env");
  assertRequiredEnv();
  console.log("STEP 3: env OK");

  const app = express();
  console.log("STEP 4: express created");

  const allowedOrigins = [
    "https://staff.boreal.financial",
    "https://client.boreal.financial",
    ...(process.env.CORS_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
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
    res.json({ ok: true });
  });

  console.log("STEP 5: before routes");
  app.use("/auth", authRoutes);

  app.use("/telephony", telephonyRoutes);
  console.log("STEP 6: routes mounted");

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const anyErr = err as { status?: number; message?: string };

    console.error("[SERVER ERROR]", err);
    return res.status(anyErr?.status || 500).json({
      error: "internal_error",
      ...(process.env.NODE_ENV !== "production" && { message: anyErr?.message }),
    });
  });

  app.use((_: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}
