import { deleteOtp, fetchOtp, storeOtp as persistOtp } from "../services/otpService.js";
import { config } from "../config/index.js";

export function normalizePhone(phone: string): string {
  let p = phone.replace(/\D/g, "");
  // Collapse any number of leading country-code "1"s. Browser autofill can
  // prepend an extra "1", yielding e.g. "118254511768" -> "+118254511768",
  // which is unroutable and never matches the stored OTP. Strip leading 1s
  // until a 10-digit NANP national number remains (NANP area codes never
  // start with 1, so a valid 10-digit number is never over-stripped).
  while (p.length > 10 && p.startsWith("1")) {
    p = p.slice(1);
  }
  if (p.length !== 10) throw new Error("Invalid phone");
  return `+1${p}`;
}

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function sendOtp(phone: string): Promise<string> {
  if (config.app.testMode === "true") {
    return "000000";
  }

  const normalized = normalizePhone(phone);
  const code = generateOtp();

  await persistOtp(normalized, code);

  console.log("[OTP SEND]", normalized, "[REDACTED]");

  return code;
}

export async function storeOtp(phone: string, code: string): Promise<void> {
  const normalized = normalizePhone(phone);

  await persistOtp(normalized, code);

  console.log("[OTP STORE]", normalized, "[REDACTED]");
}

export async function verifyOtp(
  phone: string,
  code: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (config.app.testMode === "true") {
    return code === "000000" ? { ok: true } : { ok: false, error: "invalid_code" };
  }

  const normalized = normalizePhone(phone);
  const stored = await fetchOtp(normalized);

  console.log("[OTP VERIFY]", normalized, stored ? "[HAS_STORED]" : "[NO_STORED]");

  if (!stored || stored !== code) {
    return { ok: false, error: "invalid_code" };
  }

  await deleteOtp(normalized);

  return { ok: true };
}
