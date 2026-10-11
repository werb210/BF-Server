export const ROLES = {
  ADMIN: "Admin",
  STAFF: "Staff",
  OPS: "Ops",
  MARKETING: "Marketing",
  LENDER: "Lender",
  REFERRER: "Referrer",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/**
 * Canonical role set.
 * Role comparison is STRICT and CASE-SENSITIVE.
 */
const ROLE_SET: ReadonlySet<Role> = new Set(Object.values(ROLES));

export const ALL_ROLES: Role[] = [...ROLE_SET];

/**
 * Lowercase lookup table is ONLY for explicit normalization flows
 * (e.g. login / provisioning), never for auth enforcement.
 */
const ROLE_BY_LOWERCASE: ReadonlyMap<string, Role> = new Map(
  Object.values(ROLES).map((role) => [role.toLowerCase(), role])
);

/**
 * Strict role guard.
 * Do NOT normalize implicitly.
 */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLE_SET.has(value as Role);
}

/**
 * Explicit normalization helper.
 * Must be called intentionally — never inside auth middleware.
 */
export function normalizeRole(value: string): Role | null {
  const normalized = value.trim().toLowerCase();
  return ROLE_BY_LOWERCASE.get(normalized) ?? null;
}

// BF_SERVER_v784_STAFF_ONLY_AUTH - the human staff roles. Lender and Referrer are
// in ROLES for their own portals but are NOT staff; the staff middleware only
// admits these (plus service principals).
export const STAFF_ROLES: ReadonlySet<string> = new Set<string>([
  ROLES.ADMIN,
  ROLES.STAFF,
  ROLES.OPS,
  ROLES.MARKETING,
]);

// BF_SERVER_v785_STAFF_ROLE_CASE - "admin"/"staff" count as Admin/Staff.
export function isStaffRole(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const role = normalizeRole(value);
  return role !== null && STAFF_ROLES.has(role);
}
