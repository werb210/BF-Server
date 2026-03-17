export function normalizePhone(phone: string): string {
  if (!phone) {
    return "";
  }

  const digits = phone.replace(/[^\d]/g, "");
  if (!digits) {
    return "";
  }

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
    const normalizedPhone = normalizePhone(phone);
    return normalizedPhone.length > 1 ? normalizedPhone : null;
  } catch {
    return null;
  }
}
