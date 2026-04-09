import crypto from "node:crypto";
import { config } from "../config/index.js";

const OTP_SECRET = config.security.otpHashSecret ?? config.jwt.secret;

export function hashOtp(code: string): string {
  return crypto.createHmac("sha256", OTP_SECRET).update(code).digest("hex");
}
