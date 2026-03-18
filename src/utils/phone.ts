export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return phone;
}

export function tryNormalizePhone(phone: unknown): string | null {
  if (typeof phone !== "string") {
    return null;
  }

  const normalizedPhone = normalizePhone(phone);
  return normalizedPhone.length > 1 ? normalizedPhone : null;
}
