import Redis from "ioredis";
let client = null;
const memoryStore = new Map();
const inMemoryStore = createInMemoryRedis();
function createInMemoryRedis() {
    return {
        get: async (key) => memoryStore.get(key) ?? null,
        set: async (key, value) => {
            memoryStore.set(key, value);
            return "OK";
        },
        del: async (key) => {
            const existed = memoryStore.delete(key);
            return existed ? 1 : 0;
        },
    };
}
export function getRedisOrNull() {
    if (process.env.NODE_ENV === "test") {
        return inMemoryStore;
    }
    if (!process.env.REDIS_URL) {
        return null;
    }
    if (!client) {
        client = new Redis(process.env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            connectTimeout: 5000,
            retryStrategy: () => null,
        });
    }
    return client;
}
export function getRedis() {
    const redis = getRedisOrNull();
    if (!redis) {
        throw new Error("REDIS_URL required outside test");
    }
    return redis;
}
export function resetRedisMock() {
    memoryStore.clear();
    if (process.env.NODE_ENV === "test") {
        client = null;
    }
}
export async function setOtp(phone, code) {
    await getRedis().set(`otp:${phone}`, code, "EX", 300);
}
export async function fetchOtp(phone) {
    return getRedis().get(`otp:${phone}`);
}
export async function deleteOtp(phone) {
    await getRedis().del(`otp:${phone}`);
}
