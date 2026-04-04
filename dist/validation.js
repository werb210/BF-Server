"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LeadSchema = void 0;
const zod_1 = require("zod");
exports.LeadSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    phone: zod_1.z.string().min(10),
    productType: zod_1.z.string().min(1),
    businessName: zod_1.z.string().min(1),
    requestedAmount: zod_1.z.number().optional(),
}).strict();
