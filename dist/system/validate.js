"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireString = requireString;
exports.optionalString = optionalString;
function requireString(v, name) {
    if (typeof v !== "string" || !v.trim()) {
        throw Object.assign(new Error(`INVALID_${name}`), { status: 400 });
    }
    return v.trim();
}
function optionalString(v) {
    return typeof v === "string" ? v.trim() : undefined;
}
