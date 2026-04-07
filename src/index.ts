console.log("BOOT START");

import type { Request, Response } from "express";

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED", err);
});

console.log("LOADING ENV...");
const { validateRuntimeEnvOrExit } = require("./config/env");

console.log("LOADING APP...");
const loadedApp = require("./app");
const app = loadedApp.default || loadedApp;

const { initDb } = require("./db/init");
const Redis = require("ioredis");

console.log("STARTING SERVER...");

let isReady = false;

// ✅ FIXED TYPES HERE
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).send("ok");
});

app.get("/ready", (_req: Request, res: Response) => {
  if (isReady) {
    return res.status(200).send("ready");
  }
  return res.status(503).send("not ready");
});

function runStartupSelfTest() {
  try {
    require("./routes");
    require("./routes/auth");
    require("./config/env");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Startup self-test failed: ${message}`);
  }
}

validateRuntimeEnvOrExit();
runStartupSelfTest();

void (async () => {
  if (process.env.SKIP_DATABASE === "true") {
    console.log("DB SKIPPED");
  } else {
    try {
      await initDb();
      console.log("DB CONNECTED");
    } catch (err) {
      console.error("DB FAILED:", err);
    }
  }

  let redis;

  try {
    if (process.env.REDIS_URL) {
      redis = new Redis(process.env.REDIS_URL);
      console.log("REDIS CONNECTING");
    } else {
      console.log("REDIS SKIPPED");
    }
  } catch (err) {
    console.error("REDIS FAILED:", err);
  }

  void redis;

  const port = Number(process.env.PORT) || 8080;

  const startGuard = setTimeout(() => {
    console.error("SERVER DID NOT START — EXITING");
    process.exit(1);
  }, 15000);

  app.listen(port, "0.0.0.0", () => {
    clearTimeout(startGuard);
    console.log(`SERVER STARTED ON ${port}`);
    isReady = true;
  });
})();
