import { stripUndefined } from "./stripUndefined.js";

export { stripUndefined };

export function toNullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

export function toStringSafe(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}
