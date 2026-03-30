"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getIdempotent = getIdempotent;
exports.setIdempotent = setIdempotent;
const redis_1 = require("./redis");
const TTL_SECONDS = 60 * 60;
async function getIdempotent(key) {
    if (!redis_1.redis) {
        return null;
    }
    const data = await redis_1.redis.get(key);
    return data ? JSON.parse(data) : null;
}
async function setIdempotent(key, value) {
    if (!redis_1.redis) {
        return;
    }
    await redis_1.redis.set(key, JSON.stringify(value), "EX", TTL_SECONDS);
}
