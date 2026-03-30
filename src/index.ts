import "dotenv/config";
import createServer from "./server/createServer";
import { config } from "./config/env";

const PORT = Number(process.env.PORT) || 8080;

console.log("BOOT: START");
console.log("BOOT: PORT =", PORT);
void config.JWT_SECRET;

async function start() {
  try {
    const app = createServer();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[BOOT] Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("BOOT FAILURE:", err);
    process.exit(1);
  }
}

start();

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  process.exit(1);
});
