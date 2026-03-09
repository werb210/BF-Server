import { validateEnv } from "./startup/validateEnv";

validateEnv();

import { startServer } from "./server/index";

if (require.main === module && process.env.NODE_ENV !== "test") {
  startServer().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export * from "./server/index";
