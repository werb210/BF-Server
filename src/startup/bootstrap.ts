import { getPrisma } from "../infra/db";
import { getRedis } from "../infra/redis";
import { config } from "../config";

export async function bootstrap(): Promise<void> {
  await getPrisma().$connect();

  const redis = getRedis();
  if (config.redis.url && config.env !== "test" && redis) {
    try {
      await redis.ping();
    } catch {
      console.warn("Redis unavailable — continuing");
    }
  }
}
