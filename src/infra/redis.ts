import Redis from "ioredis";
import { config } from "../config";

export const redis = config.redis.url
  ? new Redis(config.redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
  : null;
