"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redis = void 0;
exports.getRedis = getRedis;
exports.resetRedisMock = resetRedisMock;
exports.setOtp = setOtp;
exports.fetchOtp = fetchOtp;
exports.deleteOtp = deleteOtp;
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
function getRedis() {
    if (process.env.NODE_ENV === "test") {
        return inMemoryStore;
    }
    if (!process.env.REDIS_URL) {
        throw new Error("REDIS_URL required outside test");
    }
    if (!client) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Redis = require("ioredis");
        client = new Redis(process.env.REDIS_URL);
    }
    return client;
}
exports.redis = getRedis();
function resetRedisMock() {
    memoryStore.clear();
    if (process.env.NODE_ENV === "test") {
        client = null;
    }
}
async function setOtp(phone, code) {
    await getRedis().set(`otp:${phone}`, code, "EX", 300);
}
async function fetchOtp(phone) {
    return getRedis().get(`otp:${phone}`);
}
async function deleteOtp(phone) {
    await getRedis().del(`otp:${phone}`);
}
