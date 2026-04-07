"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetOtpStateForTests = resetOtpStateForTests;
const express_1 = require("express");
const otp_1 = __importDefault(require("./otp"));
const me_1 = require("./me");
const redis_1 = require("../../lib/redis");
const router = (0, express_1.Router)();
function resetOtpStateForTests() {
    (0, redis_1.resetRedisMock)();
}
router.use("/otp", otp_1.default);
router.get("/me", me_1.authMeHandler);
exports.default = router;
