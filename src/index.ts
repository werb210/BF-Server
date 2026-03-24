import { startServer } from "./server/index";

void startServer().catch((err: unknown) => {
  console.error("Startup failed", err);
  process.exit(1);
});
