import crypto from "crypto";

const OTP_SECRET = process.env.OTP_HASH_SECRET || "change-me";

export function hashOtp(code: string): string {
  return crypto.createHmac("sha256", OTP_SECRET).update(code).digest("hex");
}
