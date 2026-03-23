// src/server/index.ts

import type { Express } from "express";
import type { Server } from "http";
import { validateServerEnv } from "src/server/config/config";
import { logger } from "./utils/logger";
import { markReady } from "../startupState";
import { createServer } from "./createServer";
import { db } from "../db";
import { initChatSocket } from "../modules/ai/socket.server";
import { validateStartup } from "../startup/validateStartup";
import { cleanupOtpSessions } from "../jobs/otpCleanup";
import { createOtpSessionsTable } from "../db/migrations/createOtpSessions";
import { runMigrations } from "../db/migrationRunner";
import { runMigrations as runStartupMigrations } from "../startup/runMigrations";
import { pool } from "../db";
import { assertDatabaseHealthy } from "../health/dbHealth";
import { runSelfTest } from "../_internal/selfTest";
import { config } from "../config";

let processHandlersInstalled = false;
let server: Server | null = null;
let app: Express | null = null;
const isTestMode = config.env === "test";

function installProcessHandlers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;

  process.on("unhandledRejection", (err) => {
    logger.error("unhandled_rejection", { err: err instanceof Error ? err.message : String(err) });
  });

  process.on("uncaughtException", (err) => {
    logger.error("uncaught_exception", { err: err instanceof Error ? err.message : String(err) });
  });
}


function registerOtpCleanupJob(): void {
  if (isTestMode) {
    logger.info("otp_cleanup_skipped_test_mode");
    return;
  }

  const timer = setInterval(() => {
    cleanupOtpSessions(db).catch((err) => {
      logger.error("otp_cleanup_failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }, 600000);

  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

function resolvePort(): number {
  const rawPort = String(config.port);
  if (!rawPort) {
    logger.warn("port_missing_defaulting", { fallback: 3000 });
    return 3000;
  }
  const port = Number(rawPort);
  if (Number.isNaN(port)) {
    logger.warn("port_invalid_defaulting", { value: rawPort, fallback: 3000 });
    return 3000;
  }
  return port;
}

export async function startServer() {
  logger.info("db_connected", { databaseUrl: config.db.url });
  installProcessHandlers();
  validateStartup();
  validateServerEnv();
  await assertDatabaseHealthy();
  if (config.flags.runDbMigrations) {
    logger.info("Running database migrations...");
    await runMigrations();
  }
  await runStartupMigrations(pool);
  app = await createServer();
  await createOtpSessionsTable();
  registerOtpCleanupJob();

  const listRoutes = (expressApp: Express) => {
    logger.info("\n=== REGISTERED ROUTES ===");

    expressApp?._router?.stack
      ?.filter((r: any) => r.route)
      ?.forEach((r: any) => {
        const methods = Object.keys(r.route.methods).join(",").toUpperCase();
        logger.info(`${methods} ${r.route.path}`);
      });

    logger.info("=========================\n");
  };

  setTimeout(() => {
    try {
      if (app) {
        listRoutes(app);
      }
    } catch (e) {
      logger.error("route_listing_failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }, 1000);

  const port = resolvePort();
  server = await new Promise((resolve) => {
    if (!app) {
      throw new Error("Server failed to initialize.");
    }
    const listener = app.listen(port, "0.0.0.0", () => {
      if (typeof app?.set === "function") {
        app.set("port", port);
        app.set("server", listener);
      }
      logger.info("server_listening", { port });
      logger.info(`Server running on port ${port}`);
      void runSelfTest(port);
      resolve(listener);
    });
  });

  if (!server) throw new Error("Server failed to start.");

  if (!isTestMode) {
    initChatSocket(server);
  }
  markReady();
  return server;
}

process.on("SIGTERM", async () => {
  logger.info("server_shutting_down");
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
  process.exit(0);
});

export { server };
