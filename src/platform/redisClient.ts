import type Redis from "ioredis";
import { config } from "../config";

let redisClientInstance: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClientInstance) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedis = require("ioredis") as new (...args: any[]) => Redis;
    redisClientInstance = new IORedis(config.redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      retryStrategy: () => null,
      enableReadyCheck: true,
    });
  }

  return redisClientInstance;
}

export default getRedisClient;
