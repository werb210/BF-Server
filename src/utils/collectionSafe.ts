export function toStringSet(val: unknown): Set<string> {
  if (Array.isArray(val)) return new Set<string>(val.map((item) => String(item)));
  if (val == null) return new Set<string>();
  return new Set<string>([String(val)]);
}
