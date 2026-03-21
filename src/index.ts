import "./env";
import express from "express";
import { randomUUID } from "crypto";

import { AUTH_CONTRACT } from "./contracts/auth.contract";
import { DOCUMENT_CONTRACT } from "./contracts/document.contract";

import { testDb } from "./lib/db";
import { initRedis } from "./lib/redis";
import { ENV } from "./config/env";
import cors from "cors";
import authRouter from "./routes/auth";
import documentRoutes from "./routes/documents";
import routesRouter from "./routes";
import { requestContext } from "./middleware/requestContext";
import { internalOnly } from "./middleware/internalOnly";
import { errorHandler } from "./middleware/errorHandler";

function assertContract() {
  if (!AUTH_CONTRACT.OTP_START || !DOCUMENT_CONTRACT.UPLOAD) {
    throw new Error("Contract not initialized");
  }
}

assertContract();

const app = express();

app.use((req, res, next) => {
  const requestId = req.headers["x-request-id"] || randomUUID();
  req.requestId = requestId as string;
  req.id = requestId as string;
  res.setHeader("x-request-id", requestId);
  next();
});

app.use(express.json());
app.use(requestContext);

const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

console.log("AUTH CONTRACT:", AUTH_CONTRACT);
console.log("DOCUMENT CONTRACT:", DOCUMENT_CONTRACT);

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

app.use("/api/_int", internalOnly);
app.get("/api/_int/routes", (_req, res) => {
  res.status(200).json({
    routes: [
      { routerBase: "/api/auth", routes: [{ method: "POST", path: "/api/auth/otp/start" }] },
      { routerBase: "/", routes: [{ method: "GET", path: "/health" }] },
    ],
  });
});

app.use("/api/auth", authRouter);
app.use("/api/documents", documentRoutes);
app.use("/api", routesRouter);

app.use((req, res) => {
  res.status(404).json({
    error: {
      message: "Not Found",
      requestId: req.requestId ?? req.id,
    },
    requestId: req.requestId ?? req.id,
  });
});

app.use(errorHandler);

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
