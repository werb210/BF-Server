"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicLimiter = void 0;
const express_rate_limit_1 = require("express-rate-limit");
exports.publicLimiter = (0, express_rate_limit_1.rateLimit)({
    windowMs: 10 * 60 * 1000,
    limit: 20,
    message: { error: "RATE_LIMITED" },
});
