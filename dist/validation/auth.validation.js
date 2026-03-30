"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMeSchema = exports.verifyOtpResponseSchema = exports.startOtpResponseSchema = exports.verifyOtpSchema = exports.startOtpSchema = exports.otpStartSchema = void 0;
exports.validateStartOtp = validateStartOtp;
exports.validateVerifyOtp = validateVerifyOtp;
exports.validateAuthMe = validateAuthMe;
const zod_1 = require("zod");
const roles_1 = require("../auth/roles");
const roleValues = Object.values(roles_1.ROLES);
const roleSchema = zod_1.z.enum(roleValues);
const phoneSchema = zod_1.z.string().trim().min(1, "Phone is required");
exports.otpStartSchema = zod_1.z
    .object({
    phone: phoneSchema,
})
    .passthrough();
exports.startOtpSchema = exports.otpStartSchema;
exports.verifyOtpSchema = zod_1.z
    .object({
    phone: phoneSchema,
    code: zod_1.z.string().trim().min(1, "Code is required"),
    email: zod_1.z.string().trim().email().optional(),
})
    .strict();
exports.startOtpResponseSchema = zod_1.z
    .object({
    sent: zod_1.z.literal(true),
    otp: zod_1.z.string().length(6).optional(),
})
    .strict();
exports.verifyOtpResponseSchema = zod_1.z
    .object({
    ok: zod_1.z.literal(true),
    data: zod_1.z
        .object({
        token: zod_1.z.string(),
        user: zod_1.z
            .object({
            id: zod_1.z.string(),
            role: roleSchema,
            email: zod_1.z.string().nullable(),
        })
            .strict(),
        nextPath: zod_1.z.literal("/portal"),
    })
        .strict(),
})
    .strict();
const authMeUserSchema = zod_1.z
    .object({
    id: zod_1.z.string(),
    role: roleSchema,
    silo: zod_1.z.string().nullable().optional(),
    phone: zod_1.z.string().nullable().optional(),
})
    .strict();
exports.authMeSchema = zod_1.z
    .object({
    ok: zod_1.z.literal(true),
    data: zod_1.z.object({ user: authMeUserSchema }).optional(),
    userId: zod_1.z.string().optional(),
    role: roleSchema.optional(),
    silo: zod_1.z.string().nullable().optional(),
    user: authMeUserSchema.optional(),
})
    .passthrough()
    .superRefine((value, ctx) => {
    if (!value.user && !value.data?.user) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "auth me response must contain user details",
        });
    }
});
function validateStartOtp(req) {
    return exports.startOtpSchema.safeParse(req.body);
}
function validateVerifyOtp(req) {
    return exports.verifyOtpSchema.safeParse(req.body);
}
function validateAuthMe(res) {
    return exports.authMeSchema.safeParse(res);
}
