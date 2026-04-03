"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiResponseSchema = void 0;
const zod_1 = require("zod");
exports.ApiResponseSchema = zod_1.z.union([
    zod_1.z.object({
        status: zod_1.z.literal("ok"),
        data: zod_1.z.unknown(),
    }),
    zod_1.z.object({
        status: zod_1.z.literal("error"),
        error: zod_1.z.string(),
    }),
]);
