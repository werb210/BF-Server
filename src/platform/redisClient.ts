import { config } from "../config/index.js";
import IORedis from "ioredis";

const RedisCtor = IORedis as unknown as new (...args: any[]) => any;

let redisClientInstance: any = null;

export function getRedisClient(): any {
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
