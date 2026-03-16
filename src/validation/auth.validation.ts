import type { Request } from "express";
import { z } from "zod";
import { ROLES, type Role } from "../auth/roles";

const roleValues = Object.values(ROLES) as [Role, ...Role[]];
const roleSchema = z.enum(roleValues);
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return phone;
}

const phoneSchema = z
  .string()
  .min(1, "Phone is required")
  .transform(normalizePhone)
  .refine((phone) => /^\+?[1-9]\d{1,14}$/.test(phone), {
    message: "Phone must be in E.164 format",
  });

export const startOtpSchema = z
  .object({
    phone: phoneSchema,
    email: z.string().email().optional(),
  })
  .strict();

export const verifyOtpSchema = z
  .object({
    phone: z.string(),
    code: z.string(),
    otpSessionId: z.string().optional(),
    sessionToken: z.string().optional(),
    email: z.string().email().optional(),
  })
  .refine((payload) => Boolean(payload.otpSessionId || payload.sessionToken), {
    message: "Missing OTP session id",
    path: ["otpSessionId"],
  });

export const startOtpResponseSchema = z
  .object({
    sent: z.literal(true),
    otp: z.string().length(6).optional(),
  })
  .strict();

export const verifyOtpResponseSchema = z
  .object({
    token: z.string(),
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
    user: z
      .object({
        id: z.string(),
        role: roleSchema,
        email: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const authMeSchema = z
  .object({
    ok: z.literal(true),
    userId: z.string(),
    role: roleSchema,
    silo: z.string().min(1, "Silo is required"),
    user: z
      .object({
        id: z.string(),
        role: roleSchema,
        silo: z.string().min(1, "Silo is required"),
        phone: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export function validateStartOtp(req: Request) {
  return startOtpSchema.safeParse(req.body);
}

export function validateVerifyOtp(req: Request) {
  return verifyOtpSchema.safeParse(req.body);
}

export function validateAuthMe(res: unknown) {
  return authMeSchema.safeParse(res);
}
