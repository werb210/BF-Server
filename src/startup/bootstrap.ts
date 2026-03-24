import { config } from "../config";
import { prisma } from "../infra/db";
import { redis } from "../infra/redis";

export async function bootstrap(): Promise<void> {
  await prisma.$connect();

  if (config.env !== "test" && config.redis.url && redis) {
    await redis.connect();
    await redis.ping();
  }
}
