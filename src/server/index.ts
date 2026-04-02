import { createServer } from "./createServer";
import { bootstrap } from "../startup/bootstrap";
import { deps } from "../system/deps";

export async function startServer() {
  const server = createServer(deps);

  // NON-BLOCKING BOOTSTRAP
  setImmediate(() => {
    bootstrap().catch((err) => {
      console.error("Bootstrap failed:", err);
    });
  });

  return server;
}

async function start() {
  await startServer();
}

if (require.main === module) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
