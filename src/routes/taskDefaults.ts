// BF_SERVER_v869_SETTINGS_PACK_TASK_DEFAULTS - follow-up task defaults.
//   GET /api/task-defaults/me                                   my defaults
//   PUT /api/task-defaults/me { defaults }                     save them
//   GET /api/task-defaults/suggestion?after=call|email|meeting&contact_id=   the prompt's pre-filled task (or prompt:false)
// The portal creates the task through POST /api/tasks with what the person confirms.
import { Router } from "express";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { actorId, UUID_RE, type Q } from "../settingsPack/common.js";
import { defaultsFor, saveDefaults, suggestion, validateDefaults, type FollowUpAfter } from "../tasks/taskDefaults.js";

const router = Router();
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.MARKETING] })];
const db = (): Q => pool as unknown as Q;

router.get("/me", ...staff, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, defaults: await defaultsFor(db(), String(actorId(req))) });
}));

router.put("/me", ...staff, safeHandler(async (req: any, res: any) => {
  const v = validateDefaults(req.body?.defaults);
  if (!v.ok) return res.status(400).json({ ok: false, error: "validation_error", errors: v.errors });
  await saveDefaults(db(), String(actorId(req)), v.value);
  return res.json({ ok: true, defaults: v.value });
}));

router.get("/suggestion", ...staff, safeHandler(async (req: any, res: any) => {
  const after = String(req.query?.after ?? "") as FollowUpAfter;
  if (!["call", "email", "meeting"].includes(after)) return res.status(400).json({ ok: false, error: "after_must_be_call_email_or_meeting" });
  const contactId = String(req.query?.contact_id ?? "");
  let name: string | null = null;
  if (UUID_RE.test(contactId)) {
    const r = await db().query(`SELECT COALESCE(NULLIF(name, ''), NULLIF(trim(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '')) AS name FROM contacts WHERE id::text = $1`, [contactId]);
    name = r.rows[0]?.name ?? null;
  }
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, ...suggestion(await defaultsFor(db(), String(actorId(req))), after, name), contact_id: UUID_RE.test(contactId) ? contactId : null });
}));

export default router;
