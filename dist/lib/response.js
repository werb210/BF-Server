"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.fail = fail;
exports.error = error;
function isResponse(value) {
    return Boolean(value
        && typeof value === "object"
        && "status" in value
        && "json" in value);
}
function ok(first, second) {
    if (isResponse(first)) {
        return first.status(200).json({ status: "ok", data: second });
    }
    return {
        status: "ok",
        data: first,
        rid: typeof second === "string" ? second : undefined,
    };
}
function fail(first, second, third = 400) {
    if (isResponse(first)) {
        const message = typeof second === "string" ? second : "error";
        return first.status(third).json({ status: "error", error: message });
    }
    return {
        status: "error",
        error: first instanceof Error ? first.message : String(first),
        rid: typeof second === "string" ? second : undefined,
    };
}
function error(message, rid) {
    return {
        status: "error",
        error: message,
        rid,
    };
}
