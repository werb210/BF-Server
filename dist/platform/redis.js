"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRedis = getRedis;
const config_1 = require("../config");
let redisInstance = null;
function getRedis() {
    const redisUrl = config_1.config.redis.url;
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
