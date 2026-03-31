import { createApp } from "./app";
import { ENV } from "./config/env";
import { ensureDb } from "./db";

async function start() {
  if (process.env.NODE_ENV === "production") {
    await ensureDb();
  } else {
    ensureDb().catch(() => {
      console.warn("[DB] skipping in dev/test");
    });
  }

  const app = createApp();

  app.listen(Number(ENV.PORT), "0.0.0.0", () => {
    console.log(`Running on ${ENV.PORT}`);
  });
}

start();
