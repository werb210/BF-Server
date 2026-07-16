// BF_SERVER_TASKS_V1 - HubSpot-style Tasks + queues, Milestone 1 (spec:
// HubSpot Tasks & Queue Runner build spec). Silo-scoped on every read/write
// (BF/BI/SLF); views computed server-side; complete stamps completed_at
// (first-class, unlike HubSpot); delete is soft (deleted_at).
import { Router } from "express";
import { mirrorTaskToTodo } from "../modules/o365/todoSync.js"; // BF_SERVER_BLOCK_v_TASKS_TODO_SYNC_v1
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { resumeSequenceTask } from "../services/sequenceEngine.js"; // BF_SERVER_SEQ_TASK_STEP_v1
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";

function respondError(res: any, status: number, message: string): void {
  res.status(status).json({ error: { message } });
}

// BF_SERVER_SEQ_TASK_STEP_v1 (Tasks M5) - completing a SEQUENCE-sourced task
// resumes its paused enrollment. Best-effort: a resume failure must never
// fail the completion itself.
// BF_SERVER_TASKS_M6_v1 - when a recurring task is completed or deleted,
// spawn the next occurrence (parity with HubSpot's regenerate-on-
// complete/delete/overdue; the overdue arm lives in the reminders worker).
async function regenerateRecurrence(row: {
  id?: string; silo?: string; title?: string; body?: string | null; type?: string;
  priority?: string; due_at?: string | null; queue_id?: string | null;
  assignee_user_id?: string; contact_id?: string | null; company_id?: string | null;
  created_by?: string | null; repeat_active?: boolean | null;
  repeat_interval?: number | null; repeat_unit?: string | null;
}): Promise<void> {
  if (!row?.repeat_active || !row.repeat_interval || !row.repeat_unit || !row.due_at) return;
  const d = new Date(row.due_at);
  const n = row.repeat_interval;
  if (row.repeat_unit === "DAY") d.setUTCDate(d.getUTCDate() + n);
  else if (row.repeat_unit === "WEEK") d.setUTCDate(d.getUTCDate() + n * 7);
  else if (row.repeat_unit === "MONTH") d.setUTCMonth(d.getUTCMonth() + n);
  else if (row.repeat_unit === "YEAR") d.setUTCFullYear(d.getUTCFullYear() + n);
  else return;
  await pool.query(
    `INSERT INTO tasks (silo, title, body, type, priority, due_at, queue_id, assignee_user_id,
                        contact_id, company_id, created_by, source, repeat_interval, repeat_unit,
                        repeat_parent_id, repeat_active)
     SELECT silo, title, body, type, priority, $2::timestamptz, queue_id, assignee_user_id,
            contact_id, company_id, created_by, 'MANUAL', repeat_interval, repeat_unit, id, true
       FROM tasks WHERE id::text = $1
       AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.repeat_parent_id::text = $1)`,
    [row.id, d.toISOString()]
  ).catch((e) => console.warn("[tasks] recurrence regen failed", e instanceof Error ? e.message : String(e)));
}

function resumeIfSequenceTask(rows: Array<{ source?: string | null; source_ref_id?: string | null }>): void {
  for (const r of rows) {
    if (r?.source === "SEQUENCE" && r?.source_ref_id) {
      void resumeSequenceTask(pool, String(r.source_ref_id)).catch((e) =>
        console.warn("[tasks] sequence resume failed", e instanceof Error ? e.message : String(e))
      );
    }
  }
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

// ---- M2: queue shares + staff picker (BF_SERVER_TASKS_M2_M3_v1) ----------

router.get("/staff", safeHandler(async (_req: any, res: any) => {
  const r = await pool.query(
    `SELECT id, COALESCE(NULLIF(TRIM(first_name || ' ' || last_name), ''), email) AS name
       FROM users WHERE active = true ORDER BY 2`
  );
  respondOk(res, { staff: r.rows });
}));

router.get("/queues/:id/shares", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(
    `SELECT sh.user_id, COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS name
       FROM task_queue_shares sh
       JOIN task_queues q ON q.id = sh.queue_id
       LEFT JOIN users u ON u.id = sh.user_id
      WHERE sh.queue_id::text = $1 AND q.silo = $2 AND q.owner_user_id = $3`,
    [req.params.id, silo, req.user.userId]
  );
  respondOk(res, { shares: r.rows });
}));

router.post("/queues/:id/shares", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const userId = s(req.body?.user_id);
  if (!userId) { respondError(res, 400, "user_id_required"); return; }
  const own = await pool.query(
    `SELECT 1 FROM task_queues WHERE id::text = $1 AND silo = $2 AND owner_user_id = $3`,
    [req.params.id, silo, req.user.userId]
  );
  if (!own.rowCount) { respondError(res, 404, "queue_not_found"); return; }
  await pool.query(
    `INSERT INTO task_queue_shares (queue_id, user_id, silo) VALUES ($1::uuid, $2::uuid, $3)
     ON CONFLICT (queue_id, user_id) DO NOTHING`,
    [req.params.id, userId, silo]
  );
  respondOk(res, { ok: true });
}));

router.delete("/queues/:id/shares/:userId", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(
    `DELETE FROM task_queue_shares sh
      USING task_queues q
      WHERE sh.queue_id = q.id AND sh.queue_id::text = $1 AND sh.user_id::text = $2
        AND q.silo = $3 AND q.owner_user_id = $4`,
    [req.params.id, req.params.userId, silo, req.user.userId]
  );
  if (!r.rowCount) { respondError(res, 404, "share_not_found"); return; }
  respondOk(res, { ok: true });
}));

// ---- M3: the Start-N-tasks run (BF_SERVER_TASKS_M2_M3_v1) ----------------
// Stateless run: computes the ordered OPEN task list (index-view ordering:
// due asc, priority desc, created asc) with the contact channel details the
// runner and later type-specific actions (M4) need. Run state lives client-
// side; completion binds strictly to a task id (avoids HubSpot's
// cross-contact mis-completion bug by construction).

router.post("/runs", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const b = req.body ?? {};
  // BF_SERVER_TASKS_CONTACT_REQUIRED_v1 - runs only include actionable, contact-
  // attached tasks: Call/Email/SMS with a contact. To-do is excluded from runs.
  const conds: string[] = ["t.silo = $1", "t.deleted_at IS NULL", "t.status <> 'COMPLETED'", "t.contact_id IS NOT NULL", "t.type IN ('CALL','EMAIL','SMS')"];
  const vals: unknown[] = [silo];
  let i = 2;
  const view = typeof b.view === "string" ? b.view : "";
  if (view === "due_today") conds.push(`t.due_at::date = now()::date`);
  else if (view === "overdue") conds.push(`t.due_at < now() AND t.due_at::date < now()::date`);
  else if (view === "upcoming") conds.push(`(t.due_at IS NULL OR t.due_at::date > now()::date)`);
  for (const [key, col] of [["type", "t.type"], ["priority", "t.priority"], ["queue_id", "t.queue_id::text"]] as const) {
    const v = s(b[key]);
    if (v) { conds.push(`${col} = $${i}`); vals.push(v); i += 1; }
  }
  const r = await pool.query(
    `SELECT t.id, t.title, t.body, t.type, t.priority, t.due_at,
            t.queue_id, q.name AS queue_name,
            t.contact_id, c.name AS contact_name, c.phone AS contact_phone, c.email AS contact_email,
            t.company_id, co.name AS company_name
       FROM tasks t
       LEFT JOIN task_queues q ON q.id = t.queue_id
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
  const b = req.body ?? {};
  const title = s(b.title);
  if (!title) { respondError(res, 400, "title_required"); return; }
  const type = TYPES.includes(b.type) ? b.type : "TODO";
  // BF_SERVER_TASKS_CONTACT_REQUIRED_v1 - Call/Email/SMS tasks must be attached
  // to a contact (the runner navigates to the contact record and opens the
  // matching surface). To-do tasks may be contactless.
  if (["CALL", "EMAIL", "SMS"].includes(type) && !s(b.contact_id)) {
    respondError(res, 400, "contact_required_for_" + String(type).toLowerCase());
    return;
  }
  const priority = PRIORITIES.includes(b.priority) ? b.priority : "NONE";
  const assignee = s(b.assignee_user_id) ?? req.user.userId;
  // BF_SERVER_TASKS_CONTACT_SILO_v1 - a task's silo is the silo of the record it
  // is attached to. When a contact or company is given, derive the silo FROM
  // that record (the source of truth) rather than trusting the request's active
  // silo, which can lag the record being viewed and previously produced a
  // spurious silo-mismatch rejection (e.g. creating a task on a BI contact while
  // the request resolved to BF). Contactless to-dos keep the request silo.
  let silo = resolveSiloFromRequest(req);
  const contactId = s(b.contact_id);
  const companyId = s(b.company_id);
  if (contactId) {
    const cr = await pool.query<{ silo: string }>(`SELECT silo FROM contacts WHERE id::text = $1`, [contactId]);
    if (cr.rowCount) {
      silo = (cr.rows[0]!.silo || silo) as typeof silo;
    } else {
      // BF_SERVER_TASKS_BI_CONTACT_PROMOTE_v1 - the id may belong to a BI outreach
      // lead (bi_contacts), which the tasks table cannot reference (tasks.contact_id
      // is FK -> contacts). When staff task/call/email an outreach lead, promote it
      // into the main CRM contacts table (silo='BI') and attach the task to that
      // real contact - matching how a BF contact behaves. Idempotent: reuse an
      // existing BI contacts row matched by phone/email before creating one.
      const bi = await pool.query<{ full_name: string | null; email: string | null; phone_e164: string | null; company_id: string | null }>(
        `SELECT full_name, email, phone_e164, company_id FROM bi_contacts WHERE id::text = $1`,
        [contactId],
      );
      if (!bi.rowCount) { respondError(res, 400, "contact_not_found"); return; }
      const lead = bi.rows[0]!;
      const phone = lead.phone_e164 ? String(lead.phone_e164) : null;
      const email = lead.email ? String(lead.email) : null;
      let promotedId: string | null = null;
      if (phone || email) {
        const dupe = await pool.query<{ id: string }>(
          `SELECT id FROM contacts
             WHERE silo = 'BI'
               AND ( ($1::text IS NOT NULL AND phone = $1) OR ($2::text IS NOT NULL AND lower(email) = lower($2)) )
             LIMIT 1`,
          [phone, email],
        );
        if (dupe.rowCount) promotedId = dupe.rows[0]!.id;
      }
      if (!promotedId) {
        const ins = await pool.query<{ id: string }>(
          `INSERT INTO contacts (name, email, phone, silo) VALUES ($1,$2,$3,'BI') RETURNING id`,
          [lead.full_name ?? "BI Contact", email, phone],
        );
        promotedId = ins.rows[0]!.id;
      }
      b.contact_id = promotedId; // attach the task to the promoted CRM contact
      silo = "BI" as typeof silo;
    }
  } else if (companyId) {
    const cr = await pool.query<{ silo: string }>(`SELECT silo FROM companies WHERE id::text = $1`, [companyId]);
    if (!cr.rowCount) { respondError(res, 400, "company_not_found"); return; }
    silo = (cr.rows[0]!.silo || silo) as typeof silo;
  }
  // Queue must live in the task's (now record-derived) silo.
  if (s(b.queue_id)) {
    const chk = await pool.query(`SELECT 1 FROM task_queues WHERE id::text = $1 AND silo = $2`, [s(b.queue_id), silo]);
    if (!chk.rowCount) { respondError(res, 400, "queue_silo_mismatch"); return; }
  }
  // BF_SERVER_TASKS_M6_v1 - accept recurrence on create.
  const repeatUnit = ["DAY", "WEEK", "MONTH", "YEAR"].includes(b.repeat_unit) ? b.repeat_unit : null;
  const repeatInterval = repeatUnit && Number(b.repeat_interval) > 0 ? Number(b.repeat_interval) : null;
  const r = await pool.query(
    `INSERT INTO tasks (silo, title, body, type, priority, due_at, reminder_at, queue_id, assignee_user_id, contact_id, company_id, created_by, source, repeat_interval, repeat_unit, repeat_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'MANUAL',$13,$14,$15)
     RETURNING id`,
    [silo, title, s(b.body), type, priority, b.due_at || null, b.reminder_at || null, s(b.queue_id), assignee, s(b.contact_id), s(b.company_id), req.user.userId, repeatInterval, repeatUnit, !!(repeatInterval && repeatUnit)]
  );
  // BF_SERVER_BLOCK_v_TASKS_TODO_SYNC_v1 - mirror to the assignee's Microsoft To Do (fire-and-forget)
  void mirrorTaskToTodo(pool, { id: r.rows[0].id, userId: assignee, graphId: null, contactId: s(b.contact_id) ?? null, title, body: s(b.body) ?? null, dueAt: b.due_at || null, reminderAt: b.reminder_at || null, priority, status: "open" });
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
        reminder_sent_at = CASE WHEN $8 IS NOT NULL THEN NULL ELSE reminder_sent_at END,
        queue_id = CASE WHEN $9::text = '__clear__' THEN NULL WHEN $9::text IS NOT NULL THEN $9::uuid ELSE queue_id END,
        assignee_user_id = COALESCE($10::uuid, assignee_user_id),
        status = COALESCE($11, status),
        completed_at = CASE WHEN $11 = 'COMPLETED' AND status <> 'COMPLETED' THEN now()
                            WHEN $11 IS NOT NULL AND $11 <> 'COMPLETED' THEN NULL
                            ELSE completed_at END,
        updated_at = now()
      WHERE id::text = $1 AND silo = $2 AND deleted_at IS NULL
      RETURNING id, status, source, source_ref_id, graph_id, title, body, priority, due_at, reminder_at, assignee_user_id`,
    [req.params.id, silo, s(b.title), s(b.body), TYPES.includes(b.type) ? b.type : null,
     PRIORITIES.includes(b.priority) ? b.priority : null, b.due_at || null, b.reminder_at || null,
     b.queue_id === null ? "__clear__" : s(b.queue_id), s(b.assignee_user_id), status]
  );
  if (!r.rowCount) { respondError(res, 404, "task_not_found"); return; }
  if (status === "COMPLETED") resumeIfSequenceTask(r.rows); // BF_SERVER_SEQ_TASK_STEP_v1
  { const t = r.rows[0]; void mirrorTaskToTodo(pool, { id: t.id, userId: t.assignee_user_id, graphId: t.graph_id, title: t.title, body: t.body, dueAt: t.due_at, reminderAt: t.reminder_at, priority: t.priority, status: t.status === "COMPLETED" ? "done" : "open" }); }
  respondOk(res, { ok: true });
}));

router.post("/:id/complete", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(
    `UPDATE tasks SET status = 'COMPLETED', completed_at = now(), updated_at = now()
      WHERE id::text = $1 AND silo = $2 AND deleted_at IS NULL AND status <> 'COMPLETED'
      RETURNING id, source, source_ref_id, silo, title, body, type, priority, due_at,
                queue_id, assignee_user_id, contact_id, company_id, created_by,
                repeat_active, repeat_interval, repeat_unit, graph_id, reminder_at`,
    [req.params.id, silo]
  );
  if (!r.rowCount) { respondError(res, 404, "task_not_found"); return; }
  resumeIfSequenceTask(r.rows); // BF_SERVER_SEQ_TASK_STEP_v1
  await regenerateRecurrence(r.rows[0]); // BF_SERVER_TASKS_M6_v1
  { const t = r.rows[0]; void mirrorTaskToTodo(pool, { id: t.id, userId: t.assignee_user_id, graphId: t.graph_id, title: t.title, body: t.body, dueAt: t.due_at, reminderAt: t.reminder_at, priority: t.priority, status: "done" }); }
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
        WHERE id::text = ANY($1) AND silo = $2 AND deleted_at IS NULL AND status <> 'COMPLETED'
        RETURNING id, source, source_ref_id`,
      [ids, silo]
    );
    resumeIfSequenceTask(r.rows); // BF_SERVER_SEQ_TASK_STEP_v1
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
    `UPDATE tasks SET deleted_at = now(), updated_at = now() WHERE id::text = $1 AND silo = $2 AND deleted_at IS NULL
      RETURNING id, silo, title, body, type, priority, due_at, queue_id, assignee_user_id,
                contact_id, company_id, created_by, repeat_active, repeat_interval, repeat_unit`,
    [req.params.id, silo]
  );
  if (!r.rowCount) { respondError(res, 404, "task_not_found"); return; }
  await regenerateRecurrence(r.rows[0]); // BF_SERVER_TASKS_M6_v1
  respondOk(res, { ok: true });
}));

export default router;
