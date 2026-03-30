"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redisConnection = void 0;
const config_1 = require("../config");
exports.redisConnection = {
    url: config_1.config.redis.url,
    maxRetriesPerRequest: null,
};
