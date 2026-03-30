import type Redis from "ioredis";
import { config } from "../config";

let redisInstance: Redis | null = null;

export function getRedis(): Redis | null {
  const redisUrl = config.redis.url;
  if (!redisUrl) {
    return null;
  }

  if (!redisInstance) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedis = require("ioredis") as new (...args: any[]) => Redis;
    redisInstance = new IORedis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });

    redisInstance.connect().catch(() => {
      console.error("Redis connection failed");
    });
  }

  return redisInstance;
}
