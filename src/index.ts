import "./system/errors.js";
import { createApp } from "./app.js";
import { initDb } from "./db/init.js";

const PORT = Number(process.env.PORT) || 8080;

export async function start(): Promise<void> {
  await initDb();
  const app = createApp();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`SERVER STARTED ON ${PORT}`);
  });
}

if (process.env.NODE_ENV !== "test") {
  start().catch(console.error);
}
