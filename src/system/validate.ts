export function requireString(v: any, name: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw Object.assign(new Error(`INVALID_${name}`), { status: 400 });
  }
  return v.trim();
}

export function optionalString(v: any): string | undefined {
  return typeof v === "string" ? v.trim() : undefined;
}
