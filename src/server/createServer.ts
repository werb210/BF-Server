import type express from "express";
import { assertCorsConfig, buildApp, registerApiRoutes } from "../app";
import { assertEnv } from "../config";
import { warmUpDatabase } from "../db";
import { assertRequiredSchema } from "../db/schemaAssert";
import { notFoundHandler } from "../middleware/errors";
import { logError } from "../observability/logger";
import { getTwilioClient, getVerifyServiceSid } from "../services/twilio";
import { seedRequirementsForAllProducts } from "../services/lenderProductRequirementsService";
import { initializePushService } from "../services/pushService";
import { startFollowUpJobs } from "../modules/followup/followup.scheduler";

export type CreateServerOptions = {
  config?: {
    skipEnvCheck?: boolean;
    skipWarmup?: boolean;
    skipSchemaCheck?: boolean;
    skipSeed?: boolean;
    skipCorsCheck?: boolean;
    skipServicesInit?: boolean;
    startFollowUpJobs?: boolean;
  };
  db?: {
    warmUpDatabase?: () => Promise<void>;
    assertRequiredSchema?: () => Promise<void>;
  };
  services?: {
    initializePushService?: () => void;
    getTwilioClient?: () => void;
    getVerifyServiceSid?: () => void;
    seedRequirementsForAllProducts?: () => Promise<void>;
    startFollowUpJobs?: () => void;
  };
};

export async function createServer(
  options: CreateServerOptions = {}
): Promise<express.Express> {
  const app = buildApp();
  app.set("trust proxy", true);

  const config = options.config ?? {};
  const db = {
    warmUpDatabase,
    assertRequiredSchema,
    ...options.db,
  };
  const services = {
    initializePushService,
    getTwilioClient,
    getVerifyServiceSid,
    seedRequirementsForAllProducts,
    startFollowUpJobs,
    ...options.services,
  };

  if (!config.skipEnvCheck) {
    assertEnv();
  }

  if (!config.skipServicesInit) {
    services.initializePushService?.();
    services.getTwilioClient?.();
    services.getVerifyServiceSid?.();
  }

  if (!config.skipWarmup) {
    await db.warmUpDatabase?.();
  }

  if (!config.skipSchemaCheck) {
    try {
      await db.assertRequiredSchema?.();
    } catch (err) {
      logError("fatal_schema_mismatch", {
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  if (!config.skipSeed) {
    await services.seedRequirementsForAllProducts?.();
  }

  if (!config.skipCorsCheck) {
    try {
      assertCorsConfig();
    } catch (err) {
      logError("fatal_cors_assert", {
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  registerApiRoutes(app);
  app.use(notFoundHandler);

  if (config.startFollowUpJobs !== false) {
    services.startFollowUpJobs?.();
  }

  return app;
}
