"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redis = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const config_1 = require("../config");
const redisUrl = config_1.config.redis.url;
exports.redis = redisUrl
    ? new ioredis_1.default(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
    })
    : null;
if (exports.redis) {
    exports.redis.connect().catch(() => {
        console.error("Redis connection failed");
    });
}
