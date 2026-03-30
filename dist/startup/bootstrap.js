"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrap = bootstrap;
const db_1 = require("../infra/db");
const redis_1 = require("../infra/redis");
const config_1 = require("../config");
async function bootstrap() {
    await db_1.prisma.$connect();
    if (config_1.config.redis.url && config_1.config.env !== "test" && redis_1.redis) {
        try {
            await redis_1.redis.ping();
        }
        catch {
            console.warn("Redis unavailable — continuing");
        }
    }
}
