import Redis from "ioredis";
import { config } from "../config";

export const redisClient = new Redis(config.redis.url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

export default redisClient;
