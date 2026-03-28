import { createServer } from "./createServer";
import { bootstrap } from "../startup/bootstrap";
import { config } from "../config";

export async function startServer() {
  await bootstrap();

  const app = createServer();

  return app.listen(config.port, "0.0.0.0", () => {
    console.log("Server started on port", config.port);
  });
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
