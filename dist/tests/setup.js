"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const redis_1 = require("../lib/redis");
const db_test_1 = require("../lib/db.test");
const auth_routes_1 = require("../modules/auth/auth.routes");
const rateLimit_1 = require("../system/rateLimit");
(0, vitest_1.beforeEach)(async () => {
    await (0, db_test_1.resetTestDb)();
    (0, redis_1.resetRedisMock)();
    (0, auth_routes_1.resetOtpStateForTests)();
    (0, rateLimit_1.resetRateLimitForTests)();
});
