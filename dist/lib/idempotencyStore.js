import { logWarn } from "../observability/logger.js";
import { config } from "../config/index.js";
const ONE_HOUR_IN_SECONDS = 60 * 60;
const ONE_HOUR_IN_MILLISECONDS = ONE_HOUR_IN_SECONDS * 1000;
const REDIS_KEY_PREFIX = "idempotency:";
const memoryStore = new Map();
const MEMORY_STORE_MAX_ITEMS = 1_000;
let redisClient = null;
let redisReady = false;
let redisAttempted = false;
function fetchRedisClient() {
    if (redisAttempted) {
        return redisReady ? redisClient : null;
    }
    redisAttempted = true;
    const redisUrl = config.redis.url;
    if (!redisUrl) {
        return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedis = require("ioredis");
    const client = new IORedis(redisUrl, {
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
        logWarn("idempotency_redis_unavailable", {
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
export async function fetchStoredResponse(key) {
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
export async function storeResponse(key, value) {
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
export function resetIdempotencyStoreForTests() {
    if (config.env === "test") {
        memoryStore.clear();
    }
}
