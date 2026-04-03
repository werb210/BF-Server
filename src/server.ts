import { createApp } from "./app";
import { initDb } from "./db/init";

const PORT = process.env.PORT || 8080;

void (async () => {
  try {
    await initDb();
  } catch (err) {
    console.error("DB INIT FAILED:", err);
  }
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
})();
