import { createApp } from "./app";
import { initDb } from "./db/init";

console.log("PORT ENV:", process.env.PORT ?? "(undefined)");
const port = Number(process.env.PORT ?? 8080);
console.log("PORT BOUND:", port);

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
