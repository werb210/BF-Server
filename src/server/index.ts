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

if (require.main === module) {
  void startServer().catch((err: unknown) => {
    console.error("Startup failed", err);
    process.exit(1);
  });
}
