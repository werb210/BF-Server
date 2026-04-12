import "./system/errors.js";
import { createApp } from "./app.js";
import { initDb } from "./db/init.js";

async function start(): Promise<void> {
  await initDb();
  const app = createApp();
  const PORT = Number(process.env.PORT) || 8080;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`SERVER STARTED ON ${PORT}`);
  });
}

start().catch(console.error);
