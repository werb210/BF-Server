import { tryNormalizePhone } from "./phone.js";
export function normalizePhone(input) {
    return tryNormalizePhone(input) ?? "";
}
