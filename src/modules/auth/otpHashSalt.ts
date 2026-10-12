// BF_SERVER_v789_OTP_HASH_SALT
// The OTP hash salt fell back to the Twilio auth token (a third-party credential that
// then doubled as a hashing key) and then to the constant "staff-server-otp" (public in
// this repo). When OTP_HASH_SALT is unset, derive a server-only salt from JWT_SECRET
// with a fixed label instead, and warn once so ops sets a dedicated value.
import { createHmac } from "node:crypto";
import { logWarn } from "../../observability/logger.js";

export const OTP_HASH_SALT_LABEL = "otp-hash-salt";

export function resolveOtpHashSalt(
  otpHashSalt: string | undefined | null,
  jwtSecret: string | undefined | null,
): { salt: string; derived: boolean } {
  const explicit = typeof otpHashSalt === "string" ? otpHashSalt.trim() : "";
  if (explicit) return { salt: explicit, derived: false };
  const key = typeof jwtSecret === "string" ? jwtSecret : "";
  return {
    salt: createHmac("sha256", key).update(OTP_HASH_SALT_LABEL).digest("hex"),
    derived: true,
  };
}

let warned = false;

// Logs once per process; called from start() and lazily from the first OTP hash.
export function warnIfOtpHashSaltDerived(
  otpHashSalt: string | undefined | null,
): boolean {
  if (warned) return false;
  if (typeof otpHashSalt === "string" && otpHashSalt.trim()) return false;
  warned = true;
  logWarn("otp_hash_salt_unset", {
    message: "OTP_HASH_SALT is not set; deriving the OTP hash salt from JWT_SECRET. Set OTP_HASH_SALT to a dedicated random value.",
  });
  return true;
}

export function resetOtpHashSaltWarningForTests(): void {
  warned = false;
}
