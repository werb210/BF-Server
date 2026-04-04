"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MayaMessageSchema = exports.CallStatusSchema = exports.CallStartSchema = exports.LeadSchema = void 0;
const zod_1 = require("zod");
exports.LeadSchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(1),
    email: zod_1.z.string().email(),
    phone: zod_1.z.string().trim().min(1),
    businessName: zod_1.z.string().optional(),
    productType: zod_1.z.string().optional(),
    message: zod_1.z.string().optional(),
}).strict();
exports.CallStartSchema = zod_1.z.object({
    to: zod_1.z.string(),
});
exports.CallStatusSchema = zod_1.z.object({
    callId: zod_1.z.string(),
    status: zod_1.z.enum(["initiated", "ringing", "in-progress", "completed", "failed"]),
});
exports.MayaMessageSchema = zod_1.z.object({
    message: zod_1.z.string(),
});
