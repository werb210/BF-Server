"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const redis_1 = require("../lib/redis");
const dbTestUtils_1 = require("../lib/dbTestUtils");
const app_1 = require("../app");
const rateLimit_1 = require("../system/rateLimit");
(0, vitest_1.beforeEach)(async () => {
    await (0, dbTestUtils_1.resetTestDb)();
    (0, redis_1.resetRedisMock)();
    (0, app_1.resetOtpStateForTests)();
    (0, rateLimit_1.resetRateLimitForTests)();
});
