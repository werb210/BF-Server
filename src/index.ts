import app from "./app";
import { validateRuntimeEnvOrExit } from "./config/env";
import { initDb } from "./db/init";
import Redis from "ioredis";

console.log("=== BOOT START ===");

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

function runStartupSelfTest() {
  try {
    require("./routes");
    require("./routes/auth");
    require("./config/env");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Startup self-test failed: ${message}`);
    process.exit(1);
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

  app.listen(port, () => {
    console.log(`SERVER RUNNING ON ${port}`);
  });
})();
