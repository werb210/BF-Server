import { createApp } from "./app";
import { initDb } from "./db/init";

const port = process.env.PORT || 8080;

void (async () => {
  try {
    await initDb();
  } catch (err) {
    console.error("DB INIT FAILED:", err);
  }
  const app = createApp();
  app.listen(port, "0.0.0.0", () => {
    console.log(`SERVER STARTED ON ${port}`);
  });
})();
