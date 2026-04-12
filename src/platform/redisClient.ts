import { config } from "../config/index.js";
import { safeImport } from "../utils/safeImport.js";

const redisModule = await safeImport<any>("ioredis");
const RedisCtor = (redisModule?.default || redisModule) as (new (...args: any[]) => any) | null;

let redisClientInstance: any = null;

export function getRedisClient(): any {
  if (!RedisCtor) {
    return null;
  }
  if (!redisClientInstance) {
    redisClientInstance = new RedisCtor(config.redis.url, {
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
