import Redis from "ioredis";
import { config } from "../config";

const redisUrl = config.redis.url;

export const redis = redisUrl
  ? new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
  : null;

if (redis) {
  redis.connect().catch(() => {
    console.error("Redis connection failed");
  });
}
