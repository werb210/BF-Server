// BF_SERVER_v869_PHONE_MENU - Settings > Phone menu (Admins), ported from KS-server #38. One menu for the 866 main
// line, which answers for every Boreal company (Financial and Risk Management), so it is not split by silo.
//   GET    /api/phone-menu                 the menu (saved, or Boreal's live default menu), who it can ring,
//                                         the uploaded recordings, and whether the office is open right now
//   PUT    /api/phone-menu { menu }        save (validated against active users and uploaded recordings; audited)
//   POST   /api/phone-menu/reset           back to Boreal's default menu (audited)
//   POST   /api/phone-menu/audio           upload a greeting recording (multipart "file": MP3 or WAV, 5 MB; audited)
//   GET    /api/phone-menu/audio/:id       play it back in the editor
//   DELETE /api/phone-menu/audio/:id       remove a recording the menu (and no call queue's hold music) uses (audited)
// BF_SERVER_v871_CALL_QUEUES - GET also lists the active call queues an option (or the no-answer route) may point to.
import { Router } from "express";
import multer from "multer";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { actorId, auditFor } from "../settingsPack/common.js";
import { brokerageZoneName, zoneLabel } from "../settingsPack/boreal.js";
import { allOptions, displayName, officeOpen, promptText, resolveRoleRefs, staleUserIds, validateMenu, type PhoneMenu } from "../phoneMenu/menu.js";
import {
  AUDIO_TYPES, MAX_AUDIO_BYTES, activeMenuUsers, deleteAudio, roleRefIds, listAudio, loadMenu, looksLikeAudio, readAudio,
  resetMenu, saveAudio, saveMenu, type Q,
} from "../phoneMenu/store.js";

import { listQueues } from "../callQueues/queues.js";

const router = Router();
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES, files: 1 } });
const db = (): Q => pool as unknown as Q;
/** BF_SERVER_v871_CALL_QUEUES - the active call queues a menu option may point to. */
const menuQueues = async (): Promise<Array<{ id: string; name: string }>> => (await listQueues(db() as any)).map((q) => ({ id: q.id, name: q.name }));
const spokenGreeting = (m: PhoneMenu) => promptText(m.greeting, m.options, m.announceOptions);
/** Recordings a menu plays (greetings and second-menu prompts). */
const audioInUse = (m: PhoneMenu): string[] => [m.greeting.audioId, m.afterHoursGreeting.audioId,
  ...allOptions(m).map((o) => (o.target.type === "submenu" ? o.target.menu.prompt.audioId : null))].filter((x): x is string => Boolean(x));

router.get("/", ...adminOnly, safeHandler(async (_req: any, res: any) => {
  const [loaded, users, audio, refs, queues] = await Promise.all([loadMenu(db()), activeMenuUsers(db()), listAudio(db()), roleRefIds(db()), menuQueues()]);
  // The default menu names Todd and Andrew by reception role; the editor shows (and saves) the people they are today.
  const menu = resolveRoleRefs(loaded.menu, refs);
  const status = officeOpen(menu, new Date());
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    ok: true,
    menu,
    is_default: loaded.isDefault,
    updated_at: loaded.updatedAt,
    users: users.map((u) => ({ id: u.id, name: displayName(u), role: u.role ?? null })),
    audio,
    queues, // BF_SERVER_v871_CALL_QUEUES
    stale_user_ids: staleUserIds(menu, new Set(users.map((u) => u.id))),
    time_zone: brokerageZoneName(),
    zone_label: zoneLabel(),
    open_now: status.open,
    holiday_today: status.holiday,
    spoken_greeting: spokenGreeting(menu),
  });
}));

router.put("/", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const [users, audio, queues] = await Promise.all([activeMenuUsers(db()), listAudio(db()), menuQueues()]);
  const checked = validateMenu(req.body?.menu, { userIds: users.map((u) => u.id), audioIds: audio.map((a) => a.id), queueIds: queues.map((q) => q.id) });
  if (!checked.ok) return res.status(400).json({ ok: false, error: "validation_error", errors: checked.errors });
  await saveMenu(db(), checked.value, actorId(req));
  await auditFor(req, "phone_menu.updated", {
    options: allOptions(checked.value).map((o) => ({ id: o.id, digit: o.digit, label: o.label, target: o.target.type })),
    hours_enabled: checked.value.hours.enabled, holidays: checked.value.holidays.length,
  }, { type: "phone_menu", id: "1" });
  return res.json({ ok: true, menu: checked.value, spoken_greeting: spokenGreeting(checked.value) });
}));

router.post("/reset", ...adminOnly, safeHandler(async (req: any, res: any) => {
  await resetMenu(db());
  await auditFor(req, "phone_menu.reset", {}, { type: "phone_menu", id: "1" });
  const loaded = await loadMenu(db());
  return res.json({ ok: true, menu: resolveRoleRefs(loaded.menu, await roleRefIds(db())), is_default: true });
}));

router.post("/audio", ...adminOnly, (req: any, res: any, next: any) => {
  upload.single("file")(req, res, (err: unknown) => {
    if (err) {
      const tooBig = (err as { code?: string })?.code === "LIMIT_FILE_SIZE";
      return res.status(400).json({ ok: false, error: tooBig ? "file_too_large" : "upload_failed", message: tooBig ? "Recordings can be up to 5 MB." : "The upload did not arrive. Try again." });
    }
    return next();
  });
}, safeHandler(async (req: any, res: any) => {
  const file = req.file as { originalname?: string; mimetype?: string; buffer?: Buffer } | undefined;
  if (!file?.buffer?.length) return res.status(400).json({ ok: false, error: "file_required", message: "Choose an MP3 or WAV recording." });
  const type = String(file.mimetype ?? "").toLowerCase();
  if (!(AUDIO_TYPES as readonly string[]).includes(type) || !looksLikeAudio(file.buffer)) {
    return res.status(400).json({ ok: false, error: "unsupported_audio", message: "Use an MP3 or WAV recording." });
  }
  const row = await saveAudio(db(), { name: file.originalname ?? null, type: type === "audio/mp3" ? "audio/mpeg" : type, bytes: file.buffer }, actorId(req));
  await auditFor(req, "phone_menu.audio_uploaded", { file_name: row.file_name, size_bytes: row.size_bytes }, { type: "phone_menu_audio", id: row.id });
  return res.status(201).json({ ok: true, audio: row });
}));

router.get("/audio/:id", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const audio = await readAudio(db(), String(req.params.id ?? ""));
  if (!audio) return res.status(404).json({ ok: false, error: "not_found" });
  res.setHeader("Content-Type", audio.content_type);
  res.setHeader("Cache-Control", "no-store");
  return res.send(audio.bytes);
}));

router.delete("/audio/:id", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  const { menu, isDefault } = await loadMenu(db());
  if (!isDefault && audioInUse(menu).includes(id)) {
    return res.status(409).json({ ok: false, error: "in_use", message: "The menu still plays this recording. Switch that greeting to another recording or text first." });
  }
  const holdMusic = await db().query(`SELECT name FROM call_queues WHERE hold_audio_id = $1 AND archived_at IS NULL LIMIT 1`, [id]); // BF_SERVER_v871_CALL_QUEUES
  if (holdMusic.rows.length) {
    return res.status(409).json({ ok: false, error: "in_use", message: `The ${holdMusic.rows[0].name} call queue plays this recording as hold music. Choose other hold music first.` });
  }
  if (!(await deleteAudio(db(), id))) return res.status(404).json({ ok: false, error: "not_found" });
  await auditFor(req, "phone_menu.audio_deleted", {}, { type: "phone_menu_audio", id });
  return res.json({ ok: true });
}));

export default router;
