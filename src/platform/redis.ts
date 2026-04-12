import { config } from "../config/index.js";
import IORedis from "ioredis";

const RedisCtor = IORedis as unknown as new (...args: any[]) => any;

let redisInstance: any = null;

export function getRedis(): any {
  const redisUrl = config.redis.url;
  if (!redisUrl) {
    return null;
  }

  if (!redisInstance) {
    redisInstance = new RedisCtor(redisUrl, {
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
