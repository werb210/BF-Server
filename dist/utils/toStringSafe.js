"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toStringSafe = toStringSafe;
exports.toStringArraySafe = toStringArraySafe;
function toStringSafe(val) {
    if (Array.isArray(val))
        return val[0] ?? "";
    if (val == null)
        return "";
    return String(val);
}
function toStringArraySafe(val) {
    if (Array.isArray(val))
        return val.map((item) => String(item));
    if (val == null)
        return [];
    return [String(val)];
}
