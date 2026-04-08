import { startServer } from "./server";

void startServer().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Server startup failed:", message);
  process.exitCode = 1;
}).finally(() => {
  if (process.env.CI_VALIDATE === "true" && process.exitCode === 0) {
    console.log("CI_TESTS_COMPLETE");
  }
});
