import { config } from "../config/index.js";

let redisInstance: any = null;

export function getRedis(): any {
  const redisUrl = config.redis.url;
  if (!redisUrl) {
    return null;
  }

  if (!redisInstance) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedis = require("ioredis");
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
