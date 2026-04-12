import { config } from "../config/index.js";
import IORedis from "ioredis";

const RedisCtor = IORedis as unknown as new (...args: any[]) => any;

let redisInstance: any = null;

export function getRedis(): any {
  if (!config.redis.url) {
    return null;
  }

  if (!redisInstance) {
    redisInstance = new RedisCtor(config.redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });
  }

  return redisInstance;
}
