import { deleteOtp, fetchOtp, storeOtp as persistOtp } from "../services/otpService";
import { config } from "../config";

function normalizePhone(phone: string): string {
  let p = phone.replace(/\D/g, "");
  if (p.length === 10) p = "1" + p;
  if (!p.startsWith("1")) throw new Error("Invalid phone");
  return `+${p}`;
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

  console.log("[OTP SEND]", normalized, code);

  return code;
}

export async function storeOtp(phone: string, code: string): Promise<void> {
  const normalized = normalizePhone(phone);

  await persistOtp(normalized, code);

  console.log("[OTP SEND]", normalized, code);
}

export async function verifyOtp(phone: string, code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (config.app.testMode === "true") {
    return code === "000000" ? { ok: true } : { ok: false, error: "invalid_code" };
  }

  const normalized = normalizePhone(phone);
  const stored = await fetchOtp(normalized);

  console.log("[OTP VERIFY]", normalized, stored, code);

  if (!stored || stored !== code) {
    return { ok: false, error: "invalid_code" };
  }

  await deleteOtp(normalized);

  return { ok: true };
}
