import "dotenv/config";
import { createApp } from "./app";
import { verifyRuntime } from "./startup/verifyRuntime";

const app = createApp();

void (async () => {
  try {
    await verifyRuntime();
  } catch (err) {
    console.error("💥 STARTUP FAILED — EXITING");
    process.exit(1);
  }

  const port = Number(process.env.PORT) || 8080;

  app.listen(port, "0.0.0.0", () => {
    console.log(`SERVER STARTED ON ${port}`);
  });
})();
