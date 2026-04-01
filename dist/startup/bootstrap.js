"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrap = bootstrap;
const db_1 = require("../infra/db");
const redis_1 = require("../infra/redis");
const config_1 = require("../config");
async function bootstrap() {
    await (0, db_1.getPrisma)();
    const redis = (0, redis_1.getRedis)();
    if (config_1.config.redis.url && config_1.config.env !== "test" && redis) {
        try {
            await redis.ping();
        }
        catch {
            console.warn("Redis unavailable — continuing");
        }
    }
}
