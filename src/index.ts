import { createApp } from "./app";
import { ENV } from "./config/env";
import { ensureDb } from "./db";
import { processDeadLetters } from "./workers/deadLetterWorker";

async function start() {
  await ensureDb();

  const app = createApp();

  setInterval(() => {
    processDeadLetters().catch((err) =>
      console.error("Dead letter worker failed", err)
    );
  }, 15000);

  app.listen(Number(ENV.PORT), "0.0.0.0", () => {
    console.log(`Running on ${ENV.PORT}`);
  });
}

start();
