export function normalizePhone(phone: string): string {
  return phone
    .replace(/[^\d]/g, "")
    .replace(/^1/, "+1")
    .startsWith("+") ? phone : `+1${phone}`;
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
