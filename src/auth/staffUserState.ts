// BF_SERVER_v789_STAFF_USER_STATE
// A verified staff JWT used to be enough on its own: a disabled, deleted or
// demoted user kept full access until the token expired, and the role and
// capabilities came from the token rather than the account. The staff
// middlewares (middleware/auth.ts, middleware/requireAuth.ts) and URL tickets
// now load the user through this module and refuse the token when the account
// is missing, inactive, disabled or locked, or when the token's tv claim is
// older than users.token_version. The role always comes from the database.
//
// The loader is injectable so the unit suite (which signs staff JWTs against a
// loosely mocked DB) can install a claims-based loader from its setup file.
// Loader overrides live on globalThis so they survive vi.resetModules().
import { pool } from "../db.js";
import { fetchCapabilitiesForRole } from "./capabilities.js";
import { isStaffRole, normalizeRole } from "./roles.js";
import { logError } from "../observability/logger.js";
import {
  staffUserCacheMap,
  staffUserLoaderState,
  type StaffUserLoader,
  type StaffUserLoaderContext,
  type StaffUserRecord,
} from "./staffUserLoaderRegistry.js";

export {
  clearStaffUserCache,
  resetStaffUserLoader,
  setStaffUserLoader,
  type StaffUserLoader,
  type StaffUserLoaderContext,
  type StaffUserRecord,
} from "./staffUserLoaderRegistry.js";

export const STAFF_USER_CACHE_TTL_MS = 30_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STAFF_USER_LOOKUP_SQL = `SELECT id::text AS id, email, role, silo, silos, active, is_active, disabled,
       status, deleted_at, locked_until, token_version
  FROM users WHERE id = $1 LIMIT 1`;

// The production loader: one row from users by id.
export const dbStaffUserLoader: StaffUserLoader = async (userId) => {
  // users.id is a uuid; anything else names no user (and would make Postgres throw).
  if (!UUID_RE.test(userId)) return null;
  const result = await pool.query<{
    id: string;
    email: string | null;
    role: string | null;
    silo: string | null;
    silos: string[] | null;
    active: boolean | null;
    is_active: boolean | null;
    disabled: boolean | null;
    status: string | null;
    deleted_at: Date | string | null;
    locked_until: Date | string | null;
    token_version: number | null;
  }>(STAFF_USER_LOOKUP_SQL, [userId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    role: row.role ?? null,
    active: row.active ?? null,
    is_active: row.is_active ?? null,
    disabled: row.disabled ?? null,
    status: row.status ?? null,
    deleted_at: row.deleted_at ?? null,
    locked_until: row.locked_until ?? null,
    token_version: row.token_version == null ? 0 : Number(row.token_version),
    profile: { id: String(row.id), email: row.email ?? null, role: row.role ?? null, silo: row.silo ?? null, silos: row.silos ?? null },
  };
};

const state = staffUserLoaderState;
const cache = staffUserCacheMap;

// Loads the user, through the cache. Throws when the loader throws (DB down);
// the caller answers 503. Missing users are cached too, for the same 30 s.
export async function loadStaffUser(
  userId: string,
  claims: Record<string, unknown> = {},
  ctx: StaffUserLoaderContext = { profile: false },
): Promise<StaffUserRecord | null> {
  const s = state();
  const loader = s.loader ?? dbStaffUserLoader;
  if (!s.cache) return loader(userId, claims, ctx);
  const now = Date.now();
  const hit = cache().get(userId);
  if (hit && hit.expiresAt > now) return hit.record;
  const record = await loader(userId, claims, ctx);
  cache().set(userId, { record, expiresAt: now + STAFF_USER_CACHE_TTL_MS });
  if (cache().size > 5000) {
    const oldest = cache().keys().next().value;
    if (oldest !== undefined) cache().delete(oldest);
  }
  return record;
}

export type StaffUserRejection = "lookup_failed" | "user_not_found" | "user_inactive" | "user_disabled" | "user_locked" | "token_revoked" | "no_role" | "not_staff";

export type StaffUserCheck =
  | { ok: true; record: StaffUserRecord; role: string; capabilities: string[]; tokenVersion: number }
  | { ok: false; status: 401 | 403 | 503; reason: StaffUserRejection };

function claimTokenVersion(claims: Record<string, unknown>): number {
  const tv = claims.tv;
  if (typeof tv === "number" && Number.isFinite(tv)) return tv;
  return 0;
}

function isInactive(r: StaffUserRecord): boolean {
  if (r.active === false || r.is_active === false) return true;
  if (r.deleted_at !== null && r.deleted_at !== undefined) return true;
  return typeof r.status === "string" && r.status.trim().toUpperCase() === "INACTIVE";
}

function isLocked(r: StaffUserRecord, now: number): boolean {
  if (!r.locked_until) return false;
  const t = new Date(r.locked_until).getTime();
  return Number.isFinite(t) && t > now;
}

// Capabilities the token may keep: the ones the database role grants. A token
// without a capabilities claim gets the role's full set.
export function capabilitiesForDbRole(role: string, claims: Record<string, unknown>): string[] {
  const normalized = normalizeRole(role);
  const granted: readonly string[] = normalized ? fetchCapabilitiesForRole(normalized) : [];
  if (!Array.isArray(claims.capabilities)) return [...granted];
  return (claims.capabilities as unknown[]).filter(
    (c): c is string => typeof c === "string" && granted.includes(c),
  );
}

// The account check every staff-human token goes through.
export async function checkStaffUser(
  userId: string,
  claims: Record<string, unknown>,
  ctx: StaffUserLoaderContext = { profile: false },
): Promise<StaffUserCheck> {
  // An empty id still goes to the loader: the database loader answers null for it.
  let record: StaffUserRecord | null;
  try {
    record = await loadStaffUser(userId, claims, ctx);
  } catch (err) {
    // Not a silent pass: the request fails with 503 and the failure is logged.
    logError("staff_user_lookup_failed", {
      userId,
      message: err instanceof Error ? err.message : String(err),
      sql: "SELECT ... FROM users WHERE id = $1",
    });
    return { ok: false, status: 503, reason: "lookup_failed" };
  }
  if (!record) return { ok: false, status: 401, reason: "user_not_found" };
  if (record.disabled === true) return { ok: false, status: 401, reason: "user_disabled" };
  if (isInactive(record)) return { ok: false, status: 401, reason: "user_inactive" };
  if (isLocked(record, Date.now())) return { ok: false, status: 401, reason: "user_locked" };
  const tokenVersion = Number(record.token_version ?? 0) || 0;
  if (claimTokenVersion(claims) < tokenVersion) return { ok: false, status: 401, reason: "token_revoked" };
  const role = typeof record.role === "string" ? record.role.trim() : "";
  if (!role) return { ok: false, status: 401, reason: "no_role" };
  if (!isStaffRole(role)) return { ok: false, status: 403, reason: "not_staff" };
  return { ok: true, record, role, capabilities: capabilitiesForDbRole(role, claims), tokenVersion };
}
