export const ROLES = {
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
const ROLE_SET = new Set(Object.values(ROLES));
export const ALL_ROLES = [...ROLE_SET];
/**
 * Lowercase lookup table is ONLY for explicit normalization flows
 * (e.g. login / provisioning), never for auth enforcement.
 */
const ROLE_BY_LOWERCASE = new Map(Object.values(ROLES).map((role) => [role.toLowerCase(), role]));
/**
 * Strict role guard.
 * Do NOT normalize implicitly.
 */
export function isRole(value) {
    return typeof value === "string" && ROLE_SET.has(value);
}
/**
 * Explicit normalization helper.
 * Must be called intentionally — never inside auth middleware.
 */
export function normalizeRole(value) {
    const normalized = value.trim().toLowerCase();
    return ROLE_BY_LOWERCASE.get(normalized) ?? null;
}
