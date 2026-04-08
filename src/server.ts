import "dotenv/config";

import { createApp } from "./app";
import { initDb } from "./db/init";

export async function buildApp() {
  return createApp();
}

export async function startServer() {
  if (process.env.NODE_ENV !== "test") {
    await initDb();
  }

  const app = await buildApp();
  const port = Number(process.env.PORT) || 8080;

  return app.listen(port, "0.0.0.0", () => {
    console.log(`SERVER STARTED ON ${port}`);
  });
}
