import { stripUndefined } from "./stripUndefined.js";
export { stripUndefined };
export function toNullable(value) {
    return value === undefined ? null : value;
}
export function toStringSafe(value) {
    if (value === undefined || value === null)
        return "";
    return String(value);
}
