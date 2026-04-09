import { getRedis } from "./redis.js";
const TTL_SECONDS = 60 * 60;
export async function getIdempotent(key) {
    const redis = getRedis();
    if (!redis) {
        return null;
    }
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
}
export async function setIdempotent(key, value) {
    const redis = getRedis();
    if (!redis) {
        return;
    }
    await redis.set(key, JSON.stringify(value), "EX", TTL_SECONDS);
}
