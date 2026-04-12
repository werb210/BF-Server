import { config } from "../config/index.js";
import { safeImport } from "../utils/safeImport.js";

const redisModule = await safeImport<any>("ioredis");
const RedisCtor = (redisModule?.default || redisModule) as (new (...args: any[]) => any) | null;

let redisInstance: any = null;

export function getRedis(): any {
  const redisUrl = config.redis.url;
  if (!redisUrl) {
    return null;
  }

  if (!redisInstance) {
    if (!RedisCtor) {
      return null;
    }
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
