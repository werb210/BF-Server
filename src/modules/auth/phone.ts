export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length !== 11 || !digits.startsWith("1")) {
    throw new Error("Invalid phone number");
  }
  return `+${digits}`;
}

export function normalizeOtpPhone(phone: unknown): string | null {
  if (typeof phone !== "string") {
    return null;
  }

  try {
    return normalizePhone(phone);
  } catch {
    return null;
  }
}

export function normalizePhoneNumber(phone: unknown): string | null {
  if (typeof phone !== "string") {
    return null;
  }
  try {
    return normalizePhone(phone);
  } catch {
    return null;
  }
}
