// BF_SERVER_v869_SETTINGS_PACK_SECURITY - signed-in sessions (devices), per-session sign-out, sign out everywhere, and the
// Admin switch "require a passkey or two-step sign-in for all staff".
//
// Every staff sign-in opens a user_sessions row and the access token carries its id (claim "ksid"); the staff
// middleware refuses a token whose session was signed out (auth/staffUserState.ts). Tokens from before this change
// have no ksid: "sign out everywhere" still ends them (users.token_version).
//
// Strong sign-in: a passkey, Face ID on an enrolled dialler (device credential + biometric), or single sign-on is
// strong. A text-message code alone is one step; registering a passkey in that session is the second step and makes
// the session strong. While the Admin switch is on, a staff session that is not strong can only reach sign-in,
// passkey set-up, its own profile and sign-out (403 STRONG_SIGN_IN_REQUIRED elsewhere), so nobody - including the
// last Admin - is locked out: they sign in by text and add a passkey. The switch can only be turned on from a
// strong session, so the Admin turning it on has already proven they can meet it.
import { readSetting, writeSetting, type Q } from "../settingsPack/common.js";

export type SessionMethod = "otp" | "passkey" | "sso" | "device";
export const STRONG_METHODS: ReadonlySet<SessionMethod> = new Set(["passkey", "sso", "device"]);

export type SessionRow = {
  id: string; user_id: string; method: SessionMethod; strong: boolean; ip: string | null; user_agent: string | null;
  device_label: string | null; created_at: string; last_seen_at: string; revoked_at: string | null;
};
const COLS = `id::text AS id, user_id::text AS user_id, method, strong, ip, user_agent, device_label, created_at, last_seen_at, revoked_at`;

/** A short label for a browser / app string, e.g. "Safari on iPhone", "App on iPhone" (the Boreal dialler). */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = String(userAgent ?? "");
  if (!ua) return "Unknown device";
  const os = /iPad/.test(ua) ? "iPad" : /iPhone|iOS/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "device";
  const app = /CFNetwork|Darwin|Dialer|dialler/i.test(ua) && !/Safari/.test(ua) ? "App" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${app} on ${os}`;
}

/** Opens a session at sign-in; returns its id for the token's ksid claim (null when it could not be stored: logged,
 *  and the sign-in still works, as it did before sessions existed). */
export async function openSession(db: Q, args: { userId: string; method: SessionMethod; ip?: string | null; userAgent?: string | null }): Promise<string | null> {
  try {
    const ua = String(args.userAgent ?? "").slice(0, 300) || null;
    const r = await db.query(
      `INSERT INTO user_sessions (user_id, method, strong, ip, user_agent, device_label) VALUES ($1::uuid, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
      [args.userId, args.method, STRONG_METHODS.has(args.method), args.ip ? String(args.ip).slice(0, 64) : null, ua, deviceLabel(ua)],
    );
    return r.rows[0]?.id ? String(r.rows[0].id) : null;
  } catch (err) {
    console.error("[sessions] could not open a session; signing in without one", { userId: args.userId, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ------------------------------------------------------------------ the per-request check (cached briefly)
type Cached = { at: number; row: Pick<SessionRow, "user_id" | "strong" | "revoked_at" | "last_seen_at"> | null };
const cache = new Map<string, Cached>();
const CACHE_MS = 15_000;
const TOUCH_MS = 5 * 60_000;

export function clearSessionCache(id?: string): void {
  if (id) cache.delete(id); else cache.clear();
}

export type SessionCheck = { ok: true; strong: boolean } | { ok: false; status: 401 | 503; reason: "session_revoked" | "session_lookup_failed" };

export async function checkSession(db: Q, ksid: string, userId: string, now = Date.now()): Promise<SessionCheck> {
  if (!/^[0-9a-f-]{36}$/i.test(ksid)) return { ok: false, status: 401, reason: "session_revoked" };
  let hit = cache.get(ksid);
  if (!hit || now - hit.at > CACHE_MS) {
    try {
      const r = await db.query(`SELECT user_id::text AS user_id, strong, revoked_at, last_seen_at FROM user_sessions WHERE id::text = $1`, [ksid]);
      hit = { at: now, row: (r.rows[0] as Cached["row"]) ?? null };
      if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
      cache.set(ksid, hit);
    } catch (err) {
      console.error("[sessions] session lookup failed", { message: err instanceof Error ? err.message : String(err) });
      return { ok: false, status: 503, reason: "session_lookup_failed" };
    }
  }
  const row = hit.row;
  if (!row || row.revoked_at || row.user_id !== userId) return { ok: false, status: 401, reason: "session_revoked" };
  if (now - new Date(row.last_seen_at).getTime() > TOUCH_MS) {
    row.last_seen_at = new Date(now).toISOString();
    void db.query(`UPDATE user_sessions SET last_seen_at = now() WHERE id::text = $1`, [ksid])
      .catch((err: unknown) => console.warn("[sessions] last-seen update failed", { message: err instanceof Error ? err.message : String(err) }));
  }
  return { ok: true, strong: row.strong === true };
}

// ------------------------------------------------------------------ lists and sign-out
/** Sessions still signed in: not signed out, and used within the access token's lifetime (7 days). */
export async function activeSessions(db: Q, userId: string): Promise<SessionRow[]> {
  const r = await db.query(
    `SELECT ${COLS} FROM user_sessions WHERE user_id::text = $1 AND revoked_at IS NULL AND last_seen_at > now() - interval '7 days'
      ORDER BY last_seen_at DESC LIMIT 100`, [userId]);
  return r.rows as SessionRow[];
}

export async function revokeSession(db: Q, sessionId: string, userId: string | null, by: string | null): Promise<SessionRow | null> {
  const r = await db.query(
    `UPDATE user_sessions SET revoked_at = now(), revoked_by = $3::uuid
      WHERE id::text = $1 AND ($2::text IS NULL OR user_id::text = $2) AND revoked_at IS NULL RETURNING ${COLS}`,
    [sessionId, userId, by]);
  clearSessionCache(sessionId);
  // BF_SERVER_v869_SETTINGS_PACK - the device's refresh chain (v868 staff_refresh_tokens) ends with its session, so a
  // signed-out portal cannot quietly mint a new access token.
  if (r.rows[0]) await db.query(`UPDATE staff_refresh_tokens SET revoked_at = now() WHERE ksid = $1 AND revoked_at IS NULL`, [sessionId]);
  return (r.rows[0] as SessionRow) ?? null;
}

/** Signs a user out everywhere: every session, every older token (token_version), refresh tokens and dialler Face ID. */
export async function signOutEverywhere(db: Q, userId: string, by: string | null): Promise<{ sessions: number }> {
  const r = await db.query(`UPDATE user_sessions SET revoked_at = now(), revoked_by = $2::uuid WHERE user_id::text = $1 AND revoked_at IS NULL RETURNING id::text AS id`, [userId, by]);
  for (const row of r.rows) clearSessionCache(String(row.id));
  await db.query(`UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id::text = $1`, [userId]);
  await db.query(`UPDATE auth_refresh_tokens SET revoked_at = now() WHERE user_id::text = $1 AND revoked_at IS NULL`, [userId]);
  await db.query(`UPDATE staff_refresh_tokens SET revoked_at = now() WHERE user_id::text = $1 AND revoked_at IS NULL`, [userId]); // BF_SERVER_v869_SETTINGS_PACK
  await db.query(`UPDATE staff_device_credentials SET revoked_at = now() WHERE user_id::text = $1 AND revoked_at IS NULL`, [userId]);
  return { sessions: r.rows.length };
}

/** The second step: a passkey registered in a text-code session makes that session strong. */
export async function markSessionStrong(db: Q, sessionId: string, userId: string): Promise<void> {
  await db.query(`UPDATE user_sessions SET strong = true WHERE id::text = $1 AND user_id::text = $2 AND revoked_at IS NULL`, [sessionId, userId]);
  clearSessionCache(sessionId);
}

// ------------------------------------------------------------------ the Admin switch
export type SecuritySettings = { require_strong_sign_in: boolean };
const normalize = (raw: unknown): SecuritySettings => ({ require_strong_sign_in: (raw as any)?.require_strong_sign_in === true });

let current: SecuritySettings = { require_strong_sign_in: false };
/** The switch as last loaded (refreshed every minute by startSecuritySettingsRefresh, and on save). */
export function strongSignInRequired(): boolean {
  return current.require_strong_sign_in;
}
export function setSecuritySettingsForTests(v: SecuritySettings): void {
  current = v;
}

export async function loadSecuritySettings(db: Q): Promise<SecuritySettings> {
  current = await readSetting(db, "security", normalize);
  return current;
}
export async function saveSecuritySettings(db: Q, v: SecuritySettings, actor: string | null): Promise<void> {
  await writeSetting(db, "security", v, actor);
  current = v;
}

export function startSecuritySettingsRefresh(db: Q, everyMs = 60_000): { stop: () => void } {
  const tick = () => loadSecuritySettings(db).catch((err: unknown) => console.error("[security] settings refresh failed", err instanceof Error ? err.message : err));
  void tick();
  const timer = setInterval(() => { void tick(); }, everyMs);
  return { stop: () => clearInterval(timer) };
}

/** Paths a session that is not strong may still use while the switch is on: sign-in, passkey set-up, its own security
 *  page, and sign-out. */
export function allowedWithoutStrongSignIn(path: string): boolean {
  const p = String(path ?? "").split("?")[0]!;
  return /^\/api\/(auth|webauthn)(\/|$)/.test(p) || /^\/api\/security\/(status|me)(\/|$)/.test(p) || /^\/api\/_int\//.test(p);
}

const STAFF_HUMAN_ROLES = new Set(["Admin", "Staff", "Ops", "Marketing"]);

/** For the staff middlewares: true when this request must be refused because the switch is on and the session is not
 *  strong (or is a token from before sessions existed). */
export function mustRefuseWeakSession(args: { role: string | null | undefined; strong: boolean; path: string }): boolean {
  if (!strongSignInRequired()) return false;
  if (!STAFF_HUMAN_ROLES.has(String(args.role ?? ""))) return false;
  if (args.strong) return false;
  return !allowedWithoutStrongSignIn(args.path);
}

export const STRONG_SIGN_IN_BODY = {
  status: "error", error: "STRONG_SIGN_IN_REQUIRED",
  message: "Boreal requires a passkey or two-step sign-in. Sign in with your passkey, or set one up now.",
};

/** Who would meet the requirement today: users with a passkey, and Admins without one (shown before switching on). */
export async function readiness(db: Q): Promise<{ with_passkey: number; staff: number; admins_without_passkey: Array<{ id: string; name: string }> }> {
  const r = await db.query(
    `SELECT u.id::text AS id, u.role, COALESCE(NULLIF(trim(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), u.email, 'User') AS name,
            EXISTS (SELECT 1 FROM webauthn_credentials w WHERE w.user_id = u.id) AS has_passkey
       FROM users u
      WHERE COALESCE(u.active, true) AND COALESCE(u.disabled, false) = false AND u.deleted_at IS NULL
        AND u.role IN ('Admin', 'Staff', 'Ops', 'Marketing')`);
  const rows = r.rows as Array<{ id: string; role: string; name: string; has_passkey: boolean }>;
  return {
    with_passkey: rows.filter((x) => x.has_passkey).length,
    staff: rows.length,
    admins_without_passkey: rows.filter((x) => x.role === "Admin" && !x.has_passkey).map((x) => ({ id: x.id, name: x.name })),
  };
}
