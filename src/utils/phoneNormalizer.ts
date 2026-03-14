import { tryNormalizePhone } from "./phone";

export function normalizePhone(input: string): string {
  return tryNormalizePhone(input) ?? "";
}
