// BF_SERVER_v868_SLIDING_REFRESH - staff stay signed in while they keep using the portal, up to 30 days.
//
// Ported from KS-server #45 (KS_NATIVE_DESKTOP_v1_SLIDING_REFRESH). Before: a staff sign-in gave one 7-day access
// token, so the portal signed everyone out every 7 days, mid-week, whatever they were doing. (The iOS dialler keeps its
// own POST /api/auth/session/renew; this is for the staff portal - browser, iPad app and the desktop shell.)
//
// Now every portal staff sign-in (text code, passkey) also returns a refresh token. The portal trades it in
// (POST /api/auth/refresh) for a new access token and a NEW refresh token; the old one is used up (rotation).
//   - idle limit: a refresh token lasts REFRESH_IDLE_MS (7 days) from when it was issued, so an active user's window
//     keeps sliding forward and a user who stops using the portal is signed out 7 days later, as before;
//   - hard limit: no refresh chain outlives SESSION_MAX_MS (30 days) from the original sign-in - then they sign in
//     again. Access tokens minted by a refresh never run past that point either (accessLifetimeSeconds).
//   - reuse: a refresh token presented a second time more than REUSE_GRACE_MS after it was used means someone else has
//     a copy, so the whole chain ("family") is revoked and that device signs in again. Inside the grace window it is
//     two tabs refreshing at once: the second gets 409 and simply reads the token the first one stored.
// Refresh tokens are sign-in data, not CRM data, so they carry no silo: the access token minted from one takes the
// user's silo / silos from the users row at that moment, exactly like a fresh sign-in.
// ksid stays null in Boreal (there is no device-session table yet); the column is kept so the Security tab can use it.
// Each chain remembers the user's token version at sign-in: "sign out everywhere", a role change or switching the user
// off bumps it, and the chain stops (the route compares it with the user's current version).
// Tokens are random (not JWTs) and only their SHA-256 is stored. Sign out (POST /api/auth/logout with the refresh
// token, or /api/auth/refresh/revoke) ends the chain; "sign out everywhere" ends every chain the user has.
import { createHash, randomBytes, randomUUID } from "node:crypto";

export type RefreshDb = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const DAY_MS = 24 * 60 * 60 * 1000;
export const REFRESH_IDLE_MS = 7 * DAY_MS;
export const SESSION_MAX_MS = 30 * DAY_MS;
export const REUSE_GRACE_MS = 60 * 1000;
const PURGE_EVERY_MS = 60 * 60 * 1000;
const TOKEN_PREFIX = "srt_";

export type IssuedRefresh = { refreshToken: string; refreshExpiresAt: string; sessionExpiresAt: string };

export type RotateResult =
  | ({ ok: true; userId: string; familyId: string; ksid: string | null; tokenVersion: number; sessionStartedAt: Date } & IssuedRefresh)
  | { ok: false; status: 401 | 409; reason: "invalid" | "expired" | "reused" | "in_flight" };

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newRefreshToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** True for something shaped like one of our refresh tokens (cheap check before touching the database). */
export function looksLikeRefreshToken(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length <= 200 && /^srt_[A-Za-z0-9_-]{40,}$/.test(raw);
}

/** When a refresh token issued at `now` stops working: 7 days on, but never past the 30-day session limit. */
export function refreshExpiry(sessionStartedAt: Date, now: number): Date {
  return new Date(Math.min(now + REFRESH_IDLE_MS, sessionStartedAt.getTime() + SESSION_MAX_MS));
}

export function sessionExpiry(sessionStartedAt: Date): Date {
  return new Date(sessionStartedAt.getTime() + SESSION_MAX_MS);
}

/** "7d" / "12h" / "3600" / 3600 -> seconds; anything unreadable -> 7 days (the staff default). */
export function parseLifetimeSeconds(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  const m = /^\s*(\d+)\s*([smhd])?\s*$/i.exec(String(raw ?? ""));
  if (!m) return 7 * 24 * 60 * 60;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  return n > 0 ? n * mult : 7 * 24 * 60 * 60;
}

/** An access token minted from a refresh lives its usual time, cut short at the 30-day session limit (min 60 s). */
export function accessLifetimeSeconds(configured: unknown, sessionStartedAt: Date, now: number): number {
  const remaining = Math.floor((sessionStartedAt.getTime() + SESSION_MAX_MS - now) / 1000);
  return Math.max(60, Math.min(parseLifetimeSeconds(configured), remaining));
}

let lastPurge = 0;
async function purgeOld(db: RefreshDb, now: number): Promise<void> {
  if (now - lastPurge < PURGE_EVERY_MS) return;
  lastPurge = now;
  try {
    await db.query(`DELETE FROM staff_refresh_tokens WHERE expires_at < $1`, [new Date(now - REFRESH_IDLE_MS)]);
  } catch (err) {
    console.warn("[staff-refresh] purge of old refresh tokens failed", { message: err instanceof Error ? err.message : String(err) });
  }
}

async function insertToken(
  db: RefreshDb,
  args: { userId: string; ksid: string | null; tokenVersion: number; familyId: string; sessionStartedAt: Date; now: number },
): Promise<IssuedRefresh> {
  const refreshToken = newRefreshToken();
  const expiresAt = refreshExpiry(args.sessionStartedAt, args.now);
  await db.query(
    `INSERT INTO staff_refresh_tokens (id, family_id, user_id, ksid, token_version, token_hash, session_started_at, expires_at, created_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), args.familyId, args.userId, args.ksid, args.tokenVersion, hashRefreshToken(refreshToken), args.sessionStartedAt, expiresAt, new Date(args.now)],
  );
  return {
    refreshToken,
    refreshExpiresAt: expiresAt.toISOString(),
    sessionExpiresAt: sessionExpiry(args.sessionStartedAt).toISOString(),
  };
}

/** Starts a refresh chain at sign-in. */
export async function issueStaffRefresh(
  db: RefreshDb,
  args: { userId: string; ksid?: string | null; tokenVersion?: number | null },
  now = Date.now(),
): Promise<IssuedRefresh> {
  await purgeOld(db, now);
  return insertToken(db, {
    userId: args.userId, ksid: args.ksid ?? null, tokenVersion: Number(args.tokenVersion ?? 0) || 0, familyId: randomUUID(),
    sessionStartedAt: new Date(now), now,
  });
}

/**
 * The sign-in responses add these fields when they can. A failure is logged and the sign-in still succeeds (the user
 * is signed out after 7 days, as before) - a refresh-token problem must never stop anyone signing in.
 */
export async function refreshFieldsForSignIn(
  db: RefreshDb,
  args: { userId: string; ksid?: string | null; tokenVersion?: number | null },
): Promise<Partial<IssuedRefresh>> {
  try {
    return await issueStaffRefresh(db, args);
  } catch (err) {
    console.error("[staff-refresh] could not issue a refresh token; signing in without one", {
      userId: args.userId,
      message: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/** Uses up `token` and issues the next one in its chain. */
export async function rotateStaffRefresh(db: RefreshDb, token: string, now = Date.now()): Promise<RotateResult> {
  if (!looksLikeRefreshToken(token)) return { ok: false, status: 401, reason: "invalid" };
  const hash = hashRefreshToken(token);
  const at = new Date(now);
  // Claim it atomically: only one request can flip used_at from null.
  const claimed = await db.query(
    `UPDATE staff_refresh_tokens SET used_at = $2
      WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2
      RETURNING family_id::text AS family_id, user_id::text AS user_id, ksid, token_version, session_started_at`,
    [hash, at],
  );
  const row = claimed.rows[0] as
    | { family_id: string; user_id: string; ksid: string | null; token_version: number | null; session_started_at: Date | string }
    | undefined;
  if (!row) {
    const found = await db.query(
      `SELECT family_id::text AS family_id, used_at, revoked_at, expires_at FROM staff_refresh_tokens WHERE token_hash = $1`,
      [hash],
    );
    const old = found.rows[0] as { family_id: string; used_at: Date | string | null; revoked_at: Date | string | null; expires_at: Date | string } | undefined;
    if (!old || old.revoked_at) return { ok: false, status: 401, reason: "invalid" };
    if (old.used_at) {
      if (now - new Date(old.used_at).getTime() <= REUSE_GRACE_MS) return { ok: false, status: 409, reason: "in_flight" };
      await revokeRefreshFamily(db, old.family_id, now);
      console.warn("[staff-refresh] a used refresh token was presented again; the chain is revoked", { familyId: old.family_id });
      return { ok: false, status: 401, reason: "reused" };
    }
    return { ok: false, status: 401, reason: "expired" };
  }
  const sessionStartedAt = new Date(row.session_started_at);
  if (now >= sessionStartedAt.getTime() + SESSION_MAX_MS) {
    await revokeRefreshFamily(db, row.family_id, now);
    return { ok: false, status: 401, reason: "expired" };
  }
  const tokenVersion = Number(row.token_version ?? 0) || 0;
  const next = await insertToken(db, { userId: row.user_id, ksid: row.ksid ?? null, tokenVersion, familyId: row.family_id, sessionStartedAt, now });
  return { ok: true, userId: row.user_id, familyId: row.family_id, ksid: row.ksid ?? null, tokenVersion, sessionStartedAt, ...next };
}

export async function revokeRefreshFamily(db: RefreshDb, familyId: string, now = Date.now()): Promise<void> {
  await db.query(`UPDATE staff_refresh_tokens SET revoked_at = $2 WHERE family_id::text = $1 AND revoked_at IS NULL`, [familyId, new Date(now)]);
}

/** Sign-out on one device: ends the chain this token belongs to. Unknown tokens are ignored. */
export async function revokeRefreshToken(db: RefreshDb, token: unknown, now = Date.now()): Promise<boolean> {
  if (!looksLikeRefreshToken(token)) return false;
  const found = await db.query(`SELECT family_id::text AS family_id FROM staff_refresh_tokens WHERE token_hash = $1`, [hashRefreshToken(token)]);
  const familyId = found.rows[0]?.family_id as string | undefined;
  if (!familyId) return false;
  await revokeRefreshFamily(db, familyId, now);
  return true;
}

/** "Sign out everywhere": ends every chain the user has. */
export async function revokeAllStaffRefresh(db: RefreshDb, userId: string, now = Date.now()): Promise<void> {
  await db.query(`UPDATE staff_refresh_tokens SET revoked_at = $2 WHERE user_id::text = $1 AND revoked_at IS NULL`, [userId, new Date(now)]);
}

/** Test hook: forget when the last purge ran. */
export function resetStaffRefreshPurgeForTests(): void {
  lastPurge = 0;
}
