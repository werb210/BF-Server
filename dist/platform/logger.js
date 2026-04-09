import pino from "pino";
import { fetchRequestId } from "../observability/requestContext.js";
import { config } from "../config/index.js";
const SENSITIVE_FIELD_PATTERN = /(email|phone|ssn|password|token|secret|address)/i;
function sanitizeValue(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => sanitizeValue(entry));
    }
    if (value && typeof value === "object") {
        return sanitizeObject(value);
    }
    return value;
}
function sanitizeObject(payload) {
    return Object.fromEntries(Object.entries(payload).map(([key, value]) => {
        if (SENSITIVE_FIELD_PATTERN.test(key)) {
            return [key, "[REDACTED]"];
        }
        return [key, sanitizeValue(value)];
    }));
}
const base = pino({
    level: config.logLevel ?? "info",
});
export const logger = {
    info: (msg, extra = {}) => {
        base.info({ ...sanitizeObject(extra), requestId: fetchRequestId() }, msg);
    },
    warn: (msg, extra = {}) => {
        base.warn({ ...sanitizeObject(extra), requestId: fetchRequestId() }, msg);
    },
    error: (msg, extra = {}) => {
        base.error({ ...sanitizeObject(extra), requestId: fetchRequestId() }, msg);
    },
};
