import "./system/errors";
import app from "./app";
import { startDeadLetterWorker } from "./workers/deadLetterWorker";
import { verifyTwilioSetup } from "./startup/verifyCheck";
import { initDependencies } from "./system/init";
import { setupShutdown } from "./system/shutdown";
import { validateEnv } from "./system/env";

validateEnv();

async function start() {
  console.log("[BOOT] Starting server...");

  await verifyTwilioSetup();

  if (process.env.NODE_ENV !== "test") {
    startDeadLetterWorker();
  }

  const PORT = Number(process.env.PORT);

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[BOOT] Server listening on ${PORT}`);
    console.log("[BOOT] Server running");
  });

  setupShutdown(server);

  void initDependencies();
}

start().catch((err) => {
  console.error("UNHANDLED_STARTUP_ERROR", err);
});
