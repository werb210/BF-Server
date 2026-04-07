import "dotenv/config";
import { createApp } from "./app";
import { verifyRuntime } from "./startup/verifyRuntime";

const app = createApp();

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

app.get("/ready", (_req, res) => {
  res.status(200).send("ready");
});


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
