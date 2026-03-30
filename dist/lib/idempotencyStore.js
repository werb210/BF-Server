"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchStoredResponse = fetchStoredResponse;
exports.storeResponse = storeResponse;
exports.resetIdempotencyStoreForTests = resetIdempotencyStoreForTests;
const ioredis_1 = __importDefault(require("ioredis"));
const logger_1 = require("../observability/logger");
const config_1 = require("../config");
const ONE_HOUR_IN_SECONDS = 60 * 60;
const ONE_HOUR_IN_MILLISECONDS = ONE_HOUR_IN_SECONDS * 1000;
const REDIS_KEY_PREFIX = "idempotency:";
const memoryStore = new Map();
const MEMORY_STORE_MAX_ITEMS = 1000;
let redisClient = null;
let redisReady = false;
let redisAttempted = false;
function fetchRedisClient() {
    if (redisAttempted) {
        return redisReady ? redisClient : null;
    }
    redisAttempted = true;
    const redisUrl = config_1.config.redis.url;
    if (!redisUrl) {
        return null;
    }
    const client = new ioredis_1.default(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
    });
    void client
        .connect()
        .then(() => {
        redisClient = client;
        redisReady = true;
    })
        .catch((error) => {
        redisReady = false;
        void client.disconnect();
        (0, logger_1.logWarn)("idempotency_redis_unavailable", {
            error: error instanceof Error ? error.message : "redis_connect_failed",
        });
    });
    return null;
}
function memoryFallbackGet(key) {
    return memoryStore.get(key);
}
function memoryFallbackSet(key, value) {
    memoryStore.set(key, value);
    setTimeout(() => {
        memoryStore.delete(key);
    }, ONE_HOUR_IN_MILLISECONDS).unref();
    if (memoryStore.size > MEMORY_STORE_MAX_ITEMS) {
        const firstKey = memoryStore.keys().next().value;
        if (firstKey) {
            memoryStore.delete(firstKey);
        }
    }
}
async function fetchStoredResponse(key) {
    const client = fetchRedisClient();
    if (client) {
        try {
            const payload = await client.get(`${REDIS_KEY_PREFIX}${key}`);
            if (!payload) {
                return undefined;
            }
            return JSON.parse(payload);
        }
        catch {
            return memoryFallbackGet(key);
        }
    }
    return memoryFallbackGet(key);
}
async function storeResponse(key, value) {
    const client = fetchRedisClient();
    if (client) {
        try {
            await client.set(`${REDIS_KEY_PREFIX}${key}`, JSON.stringify(value), "EX", ONE_HOUR_IN_SECONDS);
            return;
        }
        catch {
            memoryFallbackSet(key, value);
            return;
        }
    }
    memoryFallbackSet(key, value);
}
function resetIdempotencyStoreForTests() {
    if (config_1.config.env === "test") {
        memoryStore.clear();
    }
}
