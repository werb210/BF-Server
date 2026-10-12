// BF_SERVER_v789_STAFF_USER_STATE
// The injectable part of src/auth/staffUserState.ts, kept free of imports so the
// vitest setup file can install a loader without loading config, the logger or
// the database module before the test's own mocks are registered. State lives
// on globalThis so it survives vi.resetModules().

export type StaffUserRecord = {
  id: string;
  role: string | null;
  active: boolean | null;
  is_active: boolean | null;
  disabled: boolean | null;
  status: string | null;
  deleted_at: Date | string | null;
  locked_until: Date | string | null;
  token_version: number | null;
  // Profile fields the middleware merges into req.user (email, silo, silos ...).
  // Null when the loader has no profile for the user.
  profile: Record<string, unknown> | null;
};

export type StaffUserLoaderContext = {
  // middleware/auth.ts merges the profile into req.user; requireAuth.ts does not.
  profile: boolean;
};

export type StaffUserLoader = (
  userId: string,
  claims: Record<string, unknown>,
  ctx: StaffUserLoaderContext,
) => Promise<StaffUserRecord | null>;

export type StaffUserLoaderState = { loader: StaffUserLoader | null; cache: boolean };
export type StaffUserCacheEntry = { record: StaffUserRecord | null; expiresAt: number };

const STATE_KEY = Symbol.for("bf-server.v789.staffUserLoader");
const CACHE_KEY = Symbol.for("bf-server.v789.staffUserCache");

export function staffUserLoaderState(): StaffUserLoaderState {
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { loader: null, cache: true } satisfies StaffUserLoaderState;
  return g[STATE_KEY] as StaffUserLoaderState;
}

export function staffUserCacheMap(): Map<string, StaffUserCacheEntry> {
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (!g[CACHE_KEY]) g[CACHE_KEY] = new Map<string, StaffUserCacheEntry>();
  return g[CACHE_KEY] as Map<string, StaffUserCacheEntry>;
}

// Replace the loader (tests). cache:false skips the 30-second cache, which a
// claims-based loader needs: two tests may sign different roles for one id.
export function setStaffUserLoader(loader: StaffUserLoader, opts: { cache?: boolean } = {}): void {
  const s = staffUserLoaderState();
  s.loader = loader;
  s.cache = opts.cache ?? true;
  staffUserCacheMap().clear();
}

// Back to the database loader, cached.
export function resetStaffUserLoader(): void {
  const s = staffUserLoaderState();
  s.loader = null;
  s.cache = true;
  staffUserCacheMap().clear();
}

// Forget a user's cached row (after a role change, disable, logout-all), or every row.
export function clearStaffUserCache(userId?: string | null): void {
  if (userId === undefined || userId === null) {
    staffUserCacheMap().clear();
    return;
  }
  staffUserCacheMap().delete(String(userId));
}
