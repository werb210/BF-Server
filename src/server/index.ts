import { createServer } from "./createServer";
import { bootstrap } from "../startup/bootstrap";
import { config } from "../config";

export async function startServer() {
  await bootstrap();

  const app = createServer();

  return app.listen(config.port, () => {
    console.log(`Server running on ${config.port}`);
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
