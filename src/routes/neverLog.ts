// BF_SERVER_v869_SETTINGS_PACK_NEVER_LOG - Settings > Never log.
//   GET    /api/never-log                 Admin/Staff: the list (staff can see why mail did not reach a timeline)
//   POST   /api/never-log { value, note? } Admin: add an email address or a domain (audited)
//   DELETE /api/never-log/:id             Admin: remove one (audited)
import { Router } from "express";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { actorId, auditFor, UUID_RE, type Q } from "../settingsPack/common.js";
import { addEntry, listEntries, parseEntry, removeEntry } from "../neverLog/neverLog.js";

const router = Router();
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const db = (): Q => pool as unknown as Q;

router.get("/", ...staff, safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, entries: await listEntries(db()) });
}));

router.post("/", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const parsed = parseEntry(req.body?.value);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: "validation_error", errors: { value: parsed.error } });
  const entry = await addEntry(db(), { value: parsed.value, kind: parsed.kind, note: String(req.body?.note ?? "").trim().slice(0, 200) || null, actor: actorId(req) });
  if (!entry) return res.status(409).json({ ok: false, error: "already_listed", errors: { value: "That is already on the list." } });
  await auditFor(req, "never_log.added", { value: entry.value, kind: entry.kind }, { type: "never_log", id: entry.id });
  return res.status(201).json({ ok: true, entry });
}));

router.delete("/:id", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  const entry = UUID_RE.test(id) ? await removeEntry(db(), id) : null;
  if (!entry) return res.status(404).json({ ok: false, error: "not_found" });
  await auditFor(req, "never_log.removed", { value: entry.value, kind: entry.kind }, { type: "never_log", id });
  return res.json({ ok: true });
}));

export default router;
