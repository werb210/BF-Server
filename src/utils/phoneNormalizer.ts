import { tryNormalizePhone } from "./phone.js";

export function normalizePhone(input: string): string {
  return tryNormalizePhone(input) ?? "";
}
