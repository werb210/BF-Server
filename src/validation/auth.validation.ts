import type { Request } from "express";
import { z } from "zod";
import { ROLES, type Role } from "../auth/roles";

const roleValues = Object.values(ROLES) as [Role, ...Role[]];
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
        sessionToken: z.string(),
        user: z
          .object({
            id: z.string(),
            role: roleSchema,
            email: z.string().nullable(),
          })
          .strict(),
        applicationId: z.string().nullable(),
        nextPath: z.literal("/portal"),
      })
      .strict(),
    error: z.null(),
    requestId: z.string().min(1),
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
