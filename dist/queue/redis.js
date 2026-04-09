import { config } from "../config/index.js";
export const redisConnection = {
    url: config.redis.url,
    maxRetriesPerRequest: null,
};
