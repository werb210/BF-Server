import { createServer } from "./createServer";
import { bootstrap } from "../startup/bootstrap";

export async function startServer() {
  const server = createServer();

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
    throw err;
  });
}
