import { tryNormalizePhone } from "../../utils/phone";

export function normalizePhoneNumber(phone: unknown): string | null {
  return tryNormalizePhone(phone);
}
