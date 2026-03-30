"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelephonyToken = void 0;
const zod_1 = require("zod");
exports.TelephonyToken = {
    response: zod_1.z.object({
        ok: zod_1.z.literal(true),
        data: zod_1.z.object({
            token: zod_1.z.string(),
        }),
    }),
};
