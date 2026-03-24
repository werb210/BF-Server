import { prisma } from "../infra/db";
import { redis } from "../infra/redis";
import { config } from "../config";

export async function bootstrap(): Promise<void> {
  await prisma.$connect();

  if (config.redis.url && config.env !== "test" && redis) {
    try {
      await redis.ping();
    } catch {
      console.warn("Redis unavailable — continuing");
    }
  }
}
