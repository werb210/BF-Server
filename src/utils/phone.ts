export function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");

  if (digits.startsWith("1") && digits.length === 11) {
    return `+${digits}`;
  }

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  return `+${digits}`;
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
