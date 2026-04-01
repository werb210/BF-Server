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

  const PORT = Number(process.env.PORT) || 8080;

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start();
