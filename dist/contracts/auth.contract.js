"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OtpVerify = exports.OtpStart = void 0;
const zod_1 = require("zod");
exports.OtpStart = {
    request: zod_1.z.object({
        phone: zod_1.z.string(),
    }),
    response: zod_1.z.object({
        ok: zod_1.z.literal(true),
    }),
};
exports.OtpVerify = {
    request: zod_1.z.object({
        phone: zod_1.z.string(),
        code: zod_1.z.string(),
    }),
    response: zod_1.z.object({
        ok: zod_1.z.literal(true),
        token: zod_1.z.string(),
    }),
};
