import { z } from "zod";

export const OtpStart = {
  request: z.object({
    phone: z.string(),
  }),
  response: z.object({
    ok: z.literal(true),
  }),
};

export const OtpVerify = {
  request: z.object({
    phone: z.string(),
    otp: z.string(),
  }),
  response: z.object({
    ok: z.literal(true),
    data: z.object({
      token: z.string(),
    }),
  }),
};
