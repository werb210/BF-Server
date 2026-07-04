// BF_SERVER_TASKS_V1 - HubSpot-style Tasks + queues, Milestone 1 (spec:
// HubSpot Tasks & Queue Runner build spec). Silo-scoped on every read/write
// (BF/BI/SLF); views computed server-side; complete stamps completed_at
// (first-class, unlike HubSpot); delete is soft (deleted_at).
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";

function respondError(res: any, status: number, message: string): void {
  res.status(status).json({ error: { message } });
}

const router = Router();
router.use(requireAuth);

const TYPES = ["CALL", "EMAIL", "SMS", "TODO"];
const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH"];
const STATUSES = ["NOT_STARTED", "IN_PROGRESS", "WAITING", "COMPLETED", "DEFERRED"];

function s(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ---- Queues -------------------------------------------------------------

router.get("/queues", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(
    `SELECT q.id, q.name, q.access_type, q.owner_user_id,
            (SELECT count(*)::int FROM tasks t WHERE t.queue_id = q.id AND t.deleted_at IS NULL AND t.status <> 'COMPLETED') AS open_count
       FROM task_queues q
      WHERE q.silo = $1
        AND (q.access_type = 'SHARED' OR q.owner_user_id = $2
             OR EXISTS (SELECT 1 FROM task_queue_shares sh WHERE sh.queue_id = q.id AND sh.user_id = $2))
      ORDER BY q.name`,
    [silo, req.user.userId]
  );
  respondOk(res, { queues: r.rows });
}));

router.post("/queues", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const name = s(req.body?.name);
  if (!name) { respondError(res, 400, "name_required"); return; }
  const access = req.body?.access_type === "SHARED" ? "SHARED" : "PRIVATE";
  const r = await pool.query(
    `INSERT INTO task_queues (silo, name, access_type, owner_user_id) VALUES ($1,$2,$3,$4) RETURNING id, name, access_type`,
    [silo, name, access, req.user.userId]
  );
  respondOk(res, { queue: r.rows[0] });
}));

router.patch("/queues/:id", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const name = s(req.body?.name);
  const access = req.body?.access_type;
  const r = await pool.query(
    `UPDATE task_queues SET
        name = COALESCE($3, name),
        access_type = COALESCE($4, access_type),
        updated_at = now()
      WHERE id::text = $1 AND silo = $2 AND owner_user_id = $5
      RETURNING id`,
    [req.params.id, silo, name, access === "SHARED" || access === "PRIVATE" ? access : null, req.user.userId]
  );
  if (!r.rowCount) { respondError(res, 404, "queue_not_found"); return; }
  respondOk(res, { ok: true });
}));

router.delete("/queues/:id", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  // Spec parity: deleting a queue removes the LABEL only; tasks survive.
  await pool.query(`UPDATE tasks SET queue_id = NULL, updated_at = now() WHERE queue_id::text = $1 AND silo = $2`, [req.params.id, silo]);
  const r = await pool.query(
    `DELETE FROM task_queues WHERE id::text = $1 AND silo = $2 AND owner_user_id = $3`,
    [req.params.id, silo, req.user.userId]
  );
  if (!r.rowCount) { respondError(res, 404, "queue_not_found"); return; }
  respondOk(res, { ok: true });
}));

// ---- Tasks --------------------------------------------------------------

router.get("/", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const view = String(req.query.view || "due_today");
  const conds: string[] = ["t.silo = $1", "t.deleted_at IS NULL"];
  const vals: unknown[] = [silo];
  let i = 2;
  if (view === "due_today") { conds.push(`t.status <> 'COMPLETED' AND t.due_at::date = now()::date`); }
  else if (view === "overdue") { conds.push(`t.status <> 'COMPLETED' AND t.due_at < now() AND t.due_at::date < now()::date`); }
  else if (view === "upcoming") { conds.push(`t.status <> 'COMPLETED' AND (t.due_at IS NULL OR t.due_at::date > now()::date)`); }
  else if (view === "completed") { conds.push(`t.status = 'COMPLETED'`); }
  else { conds.push(`t.status <> 'COMPLETED'`); }
  for (const [key, col] of [["type", "t.type"], ["priority", "t.priority"], ["queue_id", "t.queue_id::text"], ["assignee", "t.assignee_user_id::text"]] as const) {
    const v = s(req.query[key]);
    if (v) { conds.push(`${col} = $${i}`); vals.push(v); i += 1; }
  }
  const r = await pool.query(
    `SELECT t.id, t.title, t.body, t.type, t.status, t.priority, t.due_at, t.reminder_at,
            t.queue_id, q.name AS queue_name, t.assignee_user_id, COALESCE(u.first_name || ' ' || u.last_name, u.email) AS assignee_name,
            t.contact_id, c.name AS contact_name, t.company_id, co.name AS company_name,
            t.completed_at, t.created_at
       FROM tasks t
       LEFT JOIN task_queues q ON q.id = t.queue_id
       LEFT JOIN users u ON u.id = t.assignee_user_id
       LEFT JOIN contacts c ON c.id = t.contact_id
       LEFT JOIN companies co ON co.id = t.company_id
      WHERE ${conds.join(" AND ")}
      ORDER BY t.due_at ASC NULLS LAST,
               CASE t.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END,
               t.created_at ASC
      LIMIT 500`,
    vals
  );
  respondOk(res, { tasks: r.rows });
}));

router.post("/", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const b = req.body ?? {};
  const title = s(b.title);
  if (!title) { respondError(res, 400, "title_required"); return; }
  const type = TYPES.includes(b.type) ? b.type : "TODO";
  const priority = PRIORITIES.includes(b.priority) ? b.priority : "NONE";
  const assignee = s(b.assignee_user_id) ?? req.user.userId;
  // Silo integrity: queue/contact/company must live in the same silo.
  for (const [table, id] of [["task_queues", s(b.queue_id)], ["contacts", s(b.contact_id)], ["companies", s(b.company_id)]] as const) {
    if (!id) continue;
    const chk = await pool.query(`SELECT 1 FROM ${table} WHERE id::text = $1 AND silo = $2`, [id, silo]);
    if (!chk.rowCount) { respondError(res, 400, `${table.slice(0, -1)}_silo_mismatch`); return; }
  }
  const r = await pool.query(
    `INSERT INTO tasks (silo, title, body, type, priority, due_at, reminder_at, queue_id, assignee_user_id, contact_id, company_id, created_by, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'MANUAL')
     RETURNING id`,
    [silo, title, s(b.body), type, priority, b.due_at || null, b.reminder_at || null, s(b.queue_id), assignee, s(b.contact_id), s(b.company_id), req.user.userId]
  );
  respondOk(res, { id: r.rows[0].id });
}));

router.patch("/:id", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const b = req.body ?? {};
  const status = STATUSES.includes(b.status) ? b.status : null;
  const r = await pool.query(
    `UPDATE tasks SET
        title = COALESCE($3, title),
        body = COALESCE($4, body),
        type = COALESCE($5, type),
        priority = COALESCE($6, priority),
        due_at = COALESCE($7, due_at),
        reminder_at = COALESCE($8, reminder_at),
        queue_id = CASE WHEN $9::text = '__clear__' THEN NULL WHEN $9::text IS NOT NULL THEN $9::uuid ELSE queue_id END,
        assignee_user_id = COALESCE($10::uuid, assignee_user_id),
        status = COALESCE($11, status),
        completed_at = CASE WHEN $11 = 'COMPLETED' AND status <> 'COMPLETED' THEN now()
                            WHEN $11 IS NOT NULL AND $11 <> 'COMPLETED' THEN NULL
                            ELSE completed_at END,
        updated_at = now()
      WHERE id::text = $1 AND silo = $2 AND deleted_at IS NULL
      RETURNING id`,
    [req.params.id, silo, s(b.title), s(b.body), TYPES.includes(b.type) ? b.type : null,
     PRIORITIES.includes(b.priority) ? b.priority : null, b.due_at || null, b.reminder_at || null,
     b.queue_id === null ? "__clear__" : s(b.queue_id), s(b.assignee_user_id), status]
  );
  if (!r.rowCount) { respondError(res, 404, "task_not_found"); return; }
  respondOk(res, { ok: true });
}));

router.post("/:id/complete", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(
    `UPDATE tasks SET status = 'COMPLETED', completed_at = now(), updated_at = now()
      WHERE id::text = $1 AND silo = $2 AND deleted_at IS NULL AND status <> 'COMPLETED'
      RETURNING id`,
    [req.params.id, silo]
  );
  if (!r.rowCount) { respondError(res, 404, "task_not_found"); return; }
  respondOk(res, { ok: true });
}));

router.post("/bulk", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const action = String(req.body?.action || "");
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 500) : [];
  if (!ids.length) { respondError(res, 400, "ids_required"); return; }
  if (action === "complete") {
    const r = await pool.query(
      `UPDATE tasks SET status='COMPLETED', completed_at = now(), updated_at = now()
        WHERE id::text = ANY($1) AND silo = $2 AND deleted_at IS NULL AND status <> 'COMPLETED'`,
      [ids, silo]
    );
    respondOk(res, { updated: r.rowCount }); return;
  }
  if (action === "change_queue") {
    const queueId = s(req.body?.queue_id);
    if (queueId) {
      const chk = await pool.query(`SELECT 1 FROM task_queues WHERE id::text = $1 AND silo = $2`, [queueId, silo]);
      if (!chk.rowCount) { respondError(res, 400, "queue_silo_mismatch"); return; }
    }
    const r = await pool.query(
      `UPDATE tasks SET queue_id = $3::uuid, updated_at = now() WHERE id::text = ANY($1) AND silo = $2 AND deleted_at IS NULL`,
      [ids, silo, queueId]
    );
    respondOk(res, { updated: r.rowCount }); return;
  }
  if (action === "delete") {
    const r = await pool.query(
      `UPDATE tasks SET deleted_at = now(), updated_at = now() WHERE id::text = ANY($1) AND silo = $2 AND deleted_at IS NULL`,
      [ids, silo]
    );
    respondOk(res, { updated: r.rowCount }); return;
  }
  respondError(res, 400, "unknown_action");
}));

router.delete("/:id", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(
    `UPDATE tasks SET deleted_at = now(), updated_at = now() WHERE id::text = $1 AND silo = $2 AND deleted_at IS NULL RETURNING id`,
    [req.params.id, silo]
  );
  if (!r.rowCount) { respondError(res, 404, "task_not_found"); return; }
  respondOk(res, { ok: true });
}));

export default router;
