// BF_SERVER_v869_SETTINGS_PACK_BLOCKED_NUMBERS - Settings > Blocked numbers (Admins).
//   GET    /api/blocked-numbers                     the list, the call setting, and recent blocked calls / texts
//   POST   /api/blocked-numbers { number, reason? } block a number (audited)
//   DELETE /api/blocked-numbers/:id                 unblock (audited)
//   PUT    /api/blocked-numbers/settings { call_action: reject|voicemail }   (audited)
import { Router } from "express";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { actorId, auditFor, UUID_RE, type Q } from "../settingsPack/common.js";
import {
  addBlocked, blockedSettings, listBlocked, normalizeNumber, recentBlockedEvents, removeBlocked, saveBlockedSettings,
} from "../voice/blockedNumbers.js";

const router = Router();
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const db = (): Q => pool as unknown as Q;

router.get("/", ...adminOnly, safeHandler(async (_req: any, res: any) => {
  const [numbers, settings, events] = await Promise.all([listBlocked(db()), blockedSettings(db()), recentBlockedEvents(db())]);
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, numbers, settings, events });
}));

router.post("/", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const number = normalizeNumber(req.body?.number);
  if (!number) return res.status(400).json({ ok: false, error: "validation_error", errors: { number: "Enter a phone number, like 403-555-0100 or +44 20 7946 0000." } });
  const row = await addBlocked(db(), number, String(req.body?.reason ?? "").trim().slice(0, 200) || null, actorId(req));
  if (!row) return res.status(409).json({ ok: false, error: "already_blocked", errors: { number: "That number is already blocked." } });
  await auditFor(req, "blocked_number.added", { number, reason: row.reason }, { type: "blocked_number", id: row.id });
  return res.status(201).json({ ok: true, number: row });
}));

router.put("/settings", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const call_action = req.body?.call_action === "voicemail" ? "voicemail" : req.body?.call_action === "reject" ? "reject" : null;
  if (!call_action) return res.status(400).json({ ok: false, error: "validation_error", errors: { call_action: "Choose a polite message or voicemail." } });
  await saveBlockedSettings(db(), { call_action }, actorId(req));
  await auditFor(req, "blocked_number.settings_updated", { call_action }, { type: "blocked_numbers", id: "blocked_numbers" });
  return res.json({ ok: true, settings: { call_action } });
}));

router.delete("/:id", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  const row = UUID_RE.test(id) ? await removeBlocked(db(), id) : null;
  if (!row) return res.status(404).json({ ok: false, error: "not_found" });
  await auditFor(req, "blocked_number.removed", { number: row.number }, { type: "blocked_number", id });
  return res.json({ ok: true });
}));

export default router;
