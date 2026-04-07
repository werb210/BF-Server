import "dotenv/config";
import { createApp } from "./app";
import { verifyRuntime } from "./startup/verifyRuntime";

const app = createApp();

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

app.get("/ready", (_req, res) => {
  res.status(200).json({ status: "ready" });
});


void (async () => {
  try {
    if (process.env.NODE_ENV !== "test") {
      await verifyRuntime();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Runtime verification failed:", message);
  }

  const port = Number(process.env.PORT) || 8080;

  app.listen(port, "0.0.0.0", () => {
    console.log(`SERVER STARTED ON ${port}`);
  });
})();
