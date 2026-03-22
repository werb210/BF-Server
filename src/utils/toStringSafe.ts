export function toStringSafe(val: unknown): string {
  if (Array.isArray(val)) return val[0] ?? "";
  if (val == null) return "";
  return String(val);
}

export function toStringArraySafe(val: unknown): string[] {
  if (Array.isArray(val)) return val.map((item) => String(item));
  if (val == null) return [];
  return [String(val)];
}
