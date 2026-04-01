process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED_REJECTION", err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT_EXCEPTION", err);
  process.exit(1);
});

import { createApp } from "./app";
import { ensureDb } from "./db";
import { processDeadLetters } from "./workers/deadLetterWorker";
import { verifyTwilioSetup } from "./startup/verifyCheck";

async function start() {
  await ensureDb();
  await verifyTwilioSetup();

  const app = createApp();

  setInterval(() => {
    processDeadLetters().catch((err) =>
      console.error("Dead letter worker failed", err)
    );
  }, 15000);

  const PORT = Number(process.env.PORT || 8080);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(JSON.stringify({
      level: "info",
      event: "server_start",
      port: PORT,
      env: process.env.NODE_ENV || "unknown"
    }));
  });
}

start().catch((err) => {
  console.error("UNHANDLED_STARTUP_ERROR", err);
  process.exit(1);
});
