"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRedisClient = getRedisClient;
const config_1 = require("../config");
let redisClientInstance = null;
function getRedisClient() {
    if (!redisClientInstance) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const IORedis = require("ioredis");
        redisClientInstance = new IORedis(config_1.config.redis.url, {
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            connectTimeout: 5000,
            retryStrategy: () => null,
            enableReadyCheck: true,
        });
    }
    return redisClientInstance;
}
exports.default = getRedisClient;
