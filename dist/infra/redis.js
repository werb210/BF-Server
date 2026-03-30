"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRedis = getRedis;
const config_1 = require("../config");
let redisInstance = null;
function getRedis() {
    if (!config_1.config.redis.url) {
        return null;
    }
    if (!redisInstance) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const IORedis = require("ioredis");
        redisInstance = new IORedis(config_1.config.redis.url, {
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            connectTimeout: 5000,
            retryStrategy: () => null,
            enableOfflineQueue: false,
        });
    }
    return redisInstance;
}
