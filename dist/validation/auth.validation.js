import { z } from "zod";
import { ROLES } from "../auth/roles.js";
const roleValues = Object.values(ROLES);
const roleSchema = z.enum(roleValues);
const phoneSchema = z.string().trim().min(1, "Phone is required");
export const otpStartSchema = z
    .object({
    phone: phoneSchema,
})
    .passthrough();
export const startOtpSchema = otpStartSchema;
export const verifyOtpSchema = z
    .object({
    phone: phoneSchema,
    code: z.string().trim().min(1, "Code is required"),
    email: z.string().trim().email().optional(),
})
    .strict();
export const startOtpResponseSchema = z
    .object({
    sent: z.literal(true),
    otp: z.string().length(6).optional(),
})
    .strict();
export const verifyOtpResponseSchema = z
    .object({
    ok: z.literal(true),
    data: z
        .object({
        token: z.string(),
        user: z
            .object({
            id: z.string(),
            role: roleSchema,
            email: z.string().nullable(),
        })
            .strict(),
        nextPath: z.literal("/portal"),
    })
        .strict(),
})
    .strict();
const authMeUserSchema = z
    .object({
    id: z.string(),
    role: roleSchema,
    silo: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
})
    .strict();
export const authMeSchema = z
    .object({
    ok: z.literal(true),
    data: z.object({ user: authMeUserSchema }).optional(),
    userId: z.string().optional(),
    role: roleSchema.optional(),
    silo: z.string().nullable().optional(),
    user: authMeUserSchema.optional(),
})
    .passthrough()
    .superRefine((value, ctx) => {
    if (!value.user && !value.data?.user) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "auth me response must contain user details",
        });
    }
});
export function validateStartOtp(req) {
    return startOtpSchema.safeParse(req.body);
}
export function validateVerifyOtp(req) {
    return verifyOtpSchema.safeParse(req.body);
}
export function validateAuthMe(res) {
    return authMeSchema.safeParse(res);
}
