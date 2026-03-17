export function normalizePhone(phone: string): string {
  if (!phone) {
    throw new Error("Phone number required");
  }

  const trimmed = phone.trim();
  if (!trimmed) {
    throw new Error("Phone number required");
  }

  const hasLeadingPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  if (hasLeadingPlus && digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`;
  }

  throw new Error("Invalid phone number format");
}

export function tryNormalizePhone(phone: unknown): string | null {
  if (typeof phone !== "string") {
    return null;
  }

  try {
    return normalizePhone(phone);
  } catch {
    return null;
  }
}
