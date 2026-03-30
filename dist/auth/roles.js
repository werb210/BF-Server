"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALL_ROLES = exports.ROLES = void 0;
exports.isRole = isRole;
exports.normalizeRole = normalizeRole;
exports.ROLES = {
    ADMIN: "Admin",
    STAFF: "Staff",
    OPS: "Ops",
    LENDER: "Lender",
    REFERRER: "Referrer",
};
/**
 * Canonical role set.
 * Role comparison is STRICT and CASE-SENSITIVE.
 */
const ROLE_SET = new Set(Object.values(exports.ROLES));
exports.ALL_ROLES = [...ROLE_SET];
/**
 * Lowercase lookup table is ONLY for explicit normalization flows
 * (e.g. login / provisioning), never for auth enforcement.
 */
const ROLE_BY_LOWERCASE = new Map(Object.values(exports.ROLES).map((role) => [role.toLowerCase(), role]));
/**
 * Strict role guard.
 * Do NOT normalize implicitly.
 */
function isRole(value) {
    return typeof value === "string" && ROLE_SET.has(value);
}
/**
 * Explicit normalization helper.
 * Must be called intentionally — never inside auth middleware.
 */
function normalizeRole(value) {
    const normalized = value.trim().toLowerCase();
    return ROLE_BY_LOWERCASE.get(normalized) ?? null;
}
