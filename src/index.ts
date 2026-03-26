import { config } from "./config";
import { createServer } from "./server/createServer";
import { bootstrap } from "./startup/bootstrap";

async function start() {
  await bootstrap();

  const app = createServer();

  return app.listen(config.port, () => {
    console.log("Server started on port", config.port);
  });
}

void start().catch((err: unknown) => {
  console.error("Startup failed", err);
  process.exit(1);
});
