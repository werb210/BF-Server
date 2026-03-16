import type { Request } from "express";
import { z } from "zod";
import { ROLES, type Role } from "../auth/roles";

const roleValues = Object.values(ROLES) as [Role, ...Role[]];
const roleSchema = z.enum(roleValues);
const phoneSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{10,15}$/, "Invalid phone number")
  .transform((p) => {
    const digits = p.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.startsWith("1") && digits.length === 11) return `+${digits}`;
    if (digits.startsWith("+")) return digits;
    return `+${digits}`;
  });

export const otpStartSchema = z
  .object({
    phone: phoneSchema,
  })
  .strict();

export const startOtpSchema = otpStartSchema;

export const verifyOtpSchema = z
  .object({
    phone: phoneSchema,
    code: z.string().min(1, "Code is required"),
    email: z.string().email().optional(),
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
