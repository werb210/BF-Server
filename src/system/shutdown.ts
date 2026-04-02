import type { Server } from "http";
import { pool, runQuery } from "../db";

export function setupShutdown(server: Server) {
  const shutdown = async () => {
    console.log("[SHUTDOWN] closing");

    try {
      await pool.end();
    } catch {
      // noop
    }

    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
