import "./env";
import { createServer } from "./server/createServer";
import { assertRequiredEnv, assertSingleServerStart } from "./server/runtimeGuards";

/**
 * DO NOT hard fail on missing env in Azure.
 * Log instead so app can still boot.
 */
try {
  assertRequiredEnv(process.env);
} catch (err) {
  console.error("ENV VALIDATION WARNING:", err);
}

assertSingleServerStart();

/**
 * Never throw here — it kills the process silently in Azure
 */
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

console.log("BOOT START");

const app = createServer();

/**
 * CRITICAL FIX:
 * Azure requires PORT fallback
 */
const PORT = Number(process.env.PORT) || 8080;

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export { app };
