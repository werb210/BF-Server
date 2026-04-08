import { validateEnv } from "./config/env";
import { startServer } from "./server";

async function start() {
  try {
    validateEnv();
    await startServer();

    if (process.env.CI_VALIDATE === "true") {
      console.log("CI_TESTS_COMPLETE");
    }
  } catch (err) {
    console.error("Server startup failed:", err);
    process.exit(1);
  }
}

void start();
