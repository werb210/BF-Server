import { config } from "../config/index.js";

let redisClientInstance: any = null;

export function getRedisClient(): any {
  if (!redisClientInstance) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedis = require("ioredis");
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
