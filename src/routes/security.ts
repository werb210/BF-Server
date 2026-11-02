// BF_SERVER_v869_SETTINGS_PACK_SECURITY - Settings > Security.
//   GET  /api/security/status                               staff: is strong sign-in required, is this session strong
//   GET  /api/security/me/sessions                          staff: my signed-in devices
//   POST /api/security/me/sessions/:id/sign-out             staff: sign one of them out
//   POST /api/security/me/sign-out-everywhere               staff: sign out of every device (this one too)
//   GET  /api/security/users/:id/sessions                   Admin: anyone's devices
//   POST /api/security/users/:id/sessions/:sid/sign-out     Admin
//   POST /api/security/users/:id/sign-out-everywhere        Admin
//   GET  /api/security/settings                             Admin: the switch, and who has a passkey
//   PUT  /api/security/settings { require_strong_sign_in }  Admin: only from a strong session (no lock-out)
// Every sign-out and change is audited.
import { Router } from "express";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { clearStaffUserCache } from "../auth/staffUserState.js";
import { actorId, auditFor, UUID_RE, type Q } from "../settingsPack/common.js";
import { activeMenuUsers } from "../phoneMenu/store.js";
import { displayName } from "../phoneMenu/menu.js";
import {
  activeSessions, checkSession, readiness, revokeSession, saveSecuritySettings, signOutEverywhere, strongSignInRequired,
} from "../security/sessions.js";

const router = Router();
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS, ROLES.MARKETING] })];
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const db = (): Q => pool as unknown as Q;

const ksidOf = (req: any): string | null => (typeof req.user?.ksid === "string" && req.user.ksid ? req.user.ksid : null);

async function sessionStrong(req: any): Promise<boolean> {
  const ksid = ksidOf(req);
  if (!ksid) return false;
  const s = await checkSession(db(), ksid, String(actorId(req)));
  return s.ok && s.strong;
}

async function hasPasskey(userId: string): Promise<boolean> {
  const r = await db().query(`SELECT 1 FROM webauthn_credentials WHERE user_id::text = $1 LIMIT 1`, [userId]);
  return r.rows.length > 0;
}

const view = (rows: Awaited<ReturnType<typeof activeSessions>>, current: string | null) =>
  rows.map((s) => ({ id: s.id, device: s.device_label, method: s.method, strong: s.strong, ip: s.ip, signed_in_at: s.created_at, last_active_at: s.last_seen_at, current: s.id === current }));

router.get("/status", ...staff, safeHandler(async (req: any, res: any) => {
  const userId = String(actorId(req));
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, required: strongSignInRequired(), session_strong: await sessionStrong(req), has_passkey: await hasPasskey(userId) });
}));

router.get("/me/sessions", ...staff, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, sessions: view(await activeSessions(db(), String(actorId(req))), ksidOf(req)) });
}));

router.post("/me/sessions/:id/sign-out", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  const me = String(actorId(req));
  const row = UUID_RE.test(id) ? await revokeSession(db(), id, me, me) : null;
  if (!row) return res.status(404).json({ ok: false, error: "not_found" });
  await auditFor(req, "session.signed_out", { session_id: id, device: row.device_label }, { type: "user", id: me, userId: me });
  return res.json({ ok: true });
}));

router.post("/me/sign-out-everywhere", ...staff, safeHandler(async (req: any, res: any) => {
  const me = String(actorId(req));
  const r = await signOutEverywhere(db(), me, me);
  clearStaffUserCache(me);
  await auditFor(req, "session.signed_out_everywhere", { sessions: r.sessions }, { type: "user", id: me, userId: me });
  return res.json({ ok: true, ...r });
}));

router.get("/users/:id/sessions", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, sessions: view(await activeSessions(db(), id), ksidOf(req)), has_passkey: await hasPasskey(id) });
}));

router.post("/users/:id/sessions/:sid/sign-out", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? ""), sid = String(req.params.sid ?? "");
  const row = UUID_RE.test(id) && UUID_RE.test(sid) ? await revokeSession(db(), sid, id, actorId(req)) : null;
  if (!row) return res.status(404).json({ ok: false, error: "not_found" });
  await auditFor(req, "session.signed_out_by_admin", { session_id: sid, device: row.device_label }, { type: "user", id, userId: id });
  return res.json({ ok: true });
}));

router.post("/users/:id/sign-out-everywhere", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
  const r = await signOutEverywhere(db(), id, actorId(req));
  clearStaffUserCache(id);
  await auditFor(req, "session.signed_out_everywhere_by_admin", { sessions: r.sessions }, { type: "user", id, userId: id });
  return res.json({ ok: true, ...r });
}));

router.get("/settings", ...adminOnly, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const users = (await activeMenuUsers(db())).map((u) => ({ id: u.id, name: displayName(u) }));
  return res.json({ ok: true, require_strong_sign_in: strongSignInRequired(), session_strong: await sessionStrong(req), readiness: await readiness(db()), users });
}));

router.put("/settings", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const want = req.body?.require_strong_sign_in === true;
  // No lock-out: the switch goes on only from a session that already meets it (a passkey sign-in, a passkey added
  // after a text code, Face ID on the dialler, or single sign-on).
  if (want && !(await sessionStrong(req))) {
    return res.status(409).json({ ok: false, error: "strong_session_required", message: "Sign in with your passkey (or add one under My Profile) before requiring it for everyone." });
  }
  await saveSecuritySettings(db(), { require_strong_sign_in: want }, actorId(req));
  await auditFor(req, "security.strong_sign_in_" + (want ? "required" : "optional"), {}, { type: "security_settings", id: "security" });
  return res.json({ ok: true, require_strong_sign_in: want });
}));

export default router;
