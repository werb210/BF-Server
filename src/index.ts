import app from "./app";
import { ensureDb } from "./db";
import { processDeadLetters } from "./workers/deadLetterWorker";
import { verifyTwilioSetup } from "./startup/verifyCheck";

process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED REJECTION]", err);
});

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});

async function start() {
  console.log("[BOOT] Starting server...");

  await ensureDb();
  await verifyTwilioSetup();

  setInterval(() => {
    processDeadLetters().catch((err) =>
      console.error("Dead letter worker failed", err)
    );
  }, 15000);

  const PORT = Number(process.env.PORT || 8080);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[BOOT] Server listening on ${PORT}`);
  });
}

start().catch((err) => {
  console.error("UNHANDLED_STARTUP_ERROR", err);
  process.exit(1);
});
