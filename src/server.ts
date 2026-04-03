import { createApp } from "./app";
import { initDb } from "@/db/init";

const PORT = process.env.PORT || 8080;

void (async () => {
  await initDb();
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
})();
