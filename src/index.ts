import "dotenv/config";
import { createServer } from "./server/createServer";
import { validateEnv } from "./config/env";

const PORT = Number(process.env.PORT || 8080);
const HOST = "0.0.0.0";

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION", err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION", err);
  process.exit(1);
});

async function boot() {
  validateEnv();

  const app = await createServer();

  app.listen(PORT, HOST, () => {
    console.log(`[BOOT] server listening on ${HOST}:${PORT}`);
  });
}

boot().catch((err) => {
  console.error("[FATAL BOOT ERROR]", err);
  process.exit(1);
});
