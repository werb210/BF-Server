import { config } from "../config";
import { dbClient } from "../platform/dbClient";
import { redisClient } from "../platform/redisClient";
import { initializeAppInsights } from "../observability/appInsights";
import { initializeSentry } from "../observability/sentry";

export async function bootstrapStartup(): Promise<void> {
  void config;

  await dbClient.query("select 1");
  await redisClient.ping();
  initializeAppInsights();
  initializeSentry();
}
