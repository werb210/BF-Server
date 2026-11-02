// BF_SERVER_v871_CALL_QUEUES - /api/call-queues, ported from KS-server #47 without the plan gate.
//   GET  /                         Admin: queues, members to choose from, recordings, the main-line queue
//   POST /                         Admin: create   { name, silo, greeting, hold_message, hold_audio_id, announce_position,
//                                                    max_wait_seconds, ring_seconds, overflow, overflow_user_id, member_ids }
//   PUT  /:id                      Admin: change
//   POST /:id/archive              Admin: only with nobody waiting (menu options pointing at it fall back to no-answer)
//   PUT  /main-line                Admin: { queue_id | null } callers to the 866 number go straight into this queue
//   GET  /live                     Admin: waiting and connected callers, people, today's numbers, open callbacks
//   GET  /me | PUT /me             staff: my queues and my "available for queue calls" switch { available }
//   PUT  /agents/:userId           Admin: { available } for someone else
//   POST /callbacks/:id/done       staff: a callback request was handled
// The 866 main line answers for every Boreal company, so queues are set up once (not per silo); each queue names the
// company (BF or BI) its callers' records and missed-call alerts belong to.
import { Router } from "express";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { actorId, auditFor, readSetting, writeSetting } from "../settingsPack/common.js";
import { activeMenuUsers, listAudio } from "../phoneMenu/store.js";
import { displayName } from "../phoneMenu/menu.js";
import { MAIN_LINE_SETTING, mainLineQueue } from "../callQueues/reception.js";
import { dispatchQueue, getQueue, listQueues, livePanel, saveQueue, setAvailable, validateQueue, type Q } from "../callQueues/queues.js";

const router = Router();
const db = (): Q => pool as unknown as Q;
const admin = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS] })];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/", ...admin, safeHandler(async (_req: any, res: any) => {
  const [queues, users, audio, main] = await Promise.all([
    listQueues(db(), { includeArchived: true }), activeMenuUsers(db() as any), listAudio(db() as any), readSetting(db() as any, MAIN_LINE_SETTING, mainLineQueue),
  ]);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, queues, main_line_queue_id: main.queue_id, users: users.map((u) => ({ id: u.id, name: displayName(u) })), audio: audio.map((a) => ({ id: a.id, file_name: a.file_name })) });
}));

async function save(req: any, res: any, id: string | null) {
  const [users, audio] = await Promise.all([activeMenuUsers(db() as any), listAudio(db() as any)]);
  const v = validateQueue(req.body ?? {}, { userIds: users.map((u) => u.id), audioIds: audio.map((a) => a.id) });
  if (!v.ok) return res.status(400).json({ ok: false, error: "validation_error", message: Object.values(v.errors)[0], errors: v.errors });
  try {
    const qid = await saveQueue(db(), id, v.value, actorId(req));
    await auditFor(req, id ? "call_queue.updated" : "call_queue.created",
      { name: v.value.name, silo: v.value.silo, members: v.value.member_ids.length, max_wait_seconds: v.value.max_wait_seconds, overflow: v.value.overflow }, { type: "call_queue", id: qid });
    return res.status(id ? 200 : 201).json({ ok: true, queue: await getQueue(db(), qid) });
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "duplicate_name", message: "There is already a queue with that name.", errors: { name: "There is already a queue with that name." } });
    throw err;
  }
}

router.post("/", ...admin, safeHandler((req: any, res: any) => save(req, res, null)));

router.put("/main-line", ...admin, safeHandler(async (req: any, res: any) => {
  const v = mainLineQueue(req.body);
  if (v.queue_id) {
    const q = await getQueue(db(), v.queue_id);
    if (!q || q.archived_at) return res.status(400).json({ ok: false, error: "validation_error", message: "Choose an active queue." });
  }
  await writeSetting(db() as any, MAIN_LINE_SETTING, v, actorId(req));
  await auditFor(req, "call_queue.main_line", { queue_id: v.queue_id }, { type: "call_queue", id: v.queue_id });
  res.json({ ok: true, main_line_queue_id: v.queue_id });
}));

router.get("/live", ...admin, safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, ...(await livePanel(db())) });
}));

router.get("/me", ...staff, safeHandler(async (req: any, res: any) => {
  const me = actorId(req);
  if (!me) return res.json({ ok: true, available: false, queues: [] });
  const r = await db().query(
    `SELECT COALESCE((SELECT available FROM call_queue_agents WHERE user_id = $1::uuid), false) AS available,
            ARRAY(SELECT q.name FROM call_queue_members m JOIN call_queues q ON q.id = m.queue_id AND q.archived_at IS NULL WHERE m.user_id = $1::uuid ORDER BY q.name) AS queues`, [me]);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, available: Boolean(r.rows[0]?.available), queues: r.rows[0]?.queues ?? [] });
}));

async function setAndDispatch(userId: string, available: boolean) {
  await setAvailable(db(), userId, available);
  if (!available) return;
  const qs = await db().query(`SELECT queue_id::text AS id FROM call_queue_members WHERE user_id = $1::uuid`, [userId]);
  for (const q of qs.rows) void dispatchQueue(pool, String(q.id)).catch((err) => console.error("[call-queue] dispatch after available failed", err instanceof Error ? err.message : err));
}

router.put("/me", ...staff, safeHandler(async (req: any, res: any) => {
  const me = actorId(req);
  if (!me) return res.status(400).json({ ok: false, error: "no_user" });
  const available = req.body?.available === true;
  await setAndDispatch(me, available);
  await auditFor(req, "call_queue.availability", { available }, { type: "user", id: me, userId: me });
  res.json({ ok: true, available });
}));

router.put("/agents/:userId", ...admin, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.userId ?? "");
  if (!UUID.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
  const available = req.body?.available === true;
  await setAndDispatch(id, available);
  await auditFor(req, "call_queue.availability", { available, set_by_admin: true }, { type: "user", id, userId: id });
  res.json({ ok: true, available });
}));

router.post("/callbacks/:id/done", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  if (!UUID.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
  const r = await db().query(`UPDATE call_queue_calls SET callback_done_at = now(), callback_done_by = $2::uuid WHERE id = $1::uuid AND status = 'callback' AND callback_done_at IS NULL RETURNING id`, [id, actorId(req)]);
  if (!r.rows.length) return res.status(404).json({ ok: false, error: "not_found" });
  await auditFor(req, "call_queue.callback_done", { call_id: id }, { type: "call_queue_call", id });
  res.json({ ok: true });
}));

router.put("/:id", ...admin, safeHandler(async (req: any, res: any) => {
  const q = await getQueue(db(), String(req.params.id ?? ""));
  if (!q || q.archived_at) return res.status(404).json({ ok: false, error: "not_found" });
  return save(req, res, q.id);
}));

router.post("/:id/archive", ...admin, safeHandler(async (req: any, res: any) => {
  const q = await getQueue(db(), String(req.params.id ?? ""));
  if (!q) return res.status(404).json({ ok: false, error: "not_found" });
  const live = (await db().query(`SELECT count(*)::int AS n FROM call_queue_calls WHERE queue_id = $1::uuid AND status IN ('waiting', 'offered', 'connected')`, [q.id])).rows[0]?.n ?? 0;
  if (Number(live) > 0) return res.status(409).json({ ok: false, error: "callers_waiting", message: "Callers are in this queue right now. Try again when it is empty." });
  await db().query(`UPDATE call_queues SET archived_at = now(), updated_at = now() WHERE id = $1::uuid`, [q.id]);
  const main = await readSetting(db() as any, MAIN_LINE_SETTING, mainLineQueue);
  if (main.queue_id === q.id) await writeSetting(db() as any, MAIN_LINE_SETTING, { queue_id: null }, actorId(req));
  await auditFor(req, "call_queue.archived", { name: q.name }, { type: "call_queue", id: q.id });
  res.json({ ok: true });
}));

export default router;
