import "./env";
import express from "express";

import { testDb } from "./lib/db";
import { initRedis } from "./lib/redis";
import { ENV } from "./config/env";
import cors from "cors";
import authRouter from "./routes/auth";
import documentsRouter from "./routes/documents";
import routesRouter from "./routes";

const app = express();

app.use(express.json());

const allowedOrigins = [
  process.env.CLIENT_ORIGIN,
  process.env.PORTAL_ORIGIN,
].filter(Boolean) as string[];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    testMode: ENV.TEST_MODE,
    timestamp: Date.now(),
  });
});

app.get("/test/smoke", (_req, res) => {
  res.json({
    success: true,
    services: {
      api: true,
      redis: ENV.TEST_MODE ? "skipped" : "active",
    },
  });
});

app.use("/api/auth", authRouter);
app.use("/api/documents", documentsRouter);
app.use("/documents", documentsRouter);
app.use("/api", routesRouter);

async function safeInit() {
  if (ENV.TEST_MODE) {
    console.log("TEST_MODE enabled — skipping DB connection");
    return;
  }

  try {
    await testDb();
    initRedis();
  } catch (err) {
    console.error("DB init failed", err);
    process.exit(1);
  }
}

async function start() {
  await safeInit();

  if (process.env.NODE_ENV !== "test") {
    app.listen(ENV.PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${ENV.PORT}`);
    });
  }
}

const appReady = start().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

export { app, appReady };
export default app;
