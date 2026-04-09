import { config } from "../config/index.js";
let redisInstance = null;
export function getRedis() {
    if (!config.redis.url) {
        return null;
    }
    if (!redisInstance) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const IORedis = require("ioredis");
        redisInstance = new IORedis(config.redis.url, {
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            connectTimeout: 5000,
            retryStrategy: () => null,
            enableOfflineQueue: false,
        });
    }
    return redisInstance;
}
