import "dotenv/config";

import { createApp } from "./app";
import { initDb } from "./db/init";
import { verifyRuntime } from "./startup/verifyRuntime";

export async function buildApp() {
  return createApp();
}

export async function startServer() {
  if (process.env.NODE_ENV !== "test") {
    await initDb();
    await verifyRuntime();
  }

  const app = await buildApp();
  const port = Number(process.env.PORT) || 8080;

  return app.listen(port, "0.0.0.0", () => {
    console.log(`SERVER STARTED ON ${port}`);
  });
}

if (require.main === module) {
  void startServer().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Server startup failed:", message);
    process.exitCode = 1;
  });
}
