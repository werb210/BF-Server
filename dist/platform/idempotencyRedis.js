"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getIdempotent = getIdempotent;
exports.setIdempotent = setIdempotent;
const redis_1 = require("./redis");
const TTL_SECONDS = 60 * 60;
async function getIdempotent(key) {
    const redis = (0, redis_1.getRedis)();
    if (!redis) {
        return null;
    }
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
}
async function setIdempotent(key, value) {
    const redis = (0, redis_1.getRedis)();
    if (!redis) {
        return;
    }
    await redis.set(key, JSON.stringify(value), "EX", TTL_SECONDS);
}
