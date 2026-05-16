import express from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { respondOk } from "../../utils/respondOk.js";
import { getGraphForUser } from "../../modules/o365/graphClient.js";
// BF_SERVER_BLOCK_BI_ROUND5_CRM_SILO_RESOLVE_v1
import { resolveSiloFromRequest } from "../../middleware/silo.js";

const router = express.Router({ mergeParams: true });

router.get("/", safeHandler(async (req: any, res: any) => {
  const { contactId, companyId } = resolveScope(req);
  const silo = resolveSiloFromRequest(req);
  const where: string[] = ["t.silo = $1"]; const params: unknown[] = [silo];
  if (contactId) { params.push(contactId); where.push(`t.contact_id = $${params.length}`); }
  if (companyId) { params.push(companyId); where.push(`t.company_id = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT t.*, u.first_name || ' ' || u.last_name AS assignee_name
     FROM crm_tasks t LEFT JOIN users u ON u.id = t.assigned_to
     WHERE ${where.join(" AND ")} ORDER BY COALESCE(t.due_at, t.created_at) DESC LIMIT 200`,
    params,
  );
  respondOk(res, rows);
}));

router.post("/", safeHandler(async (req: any, res: any) => {
  const { contactId, companyId } = resolveScope(req);
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const silo = resolveSiloFromRequest(req);
  const body = req.body ?? {};
  const title = (body.title ?? "").toString().trim();
  if (!title) return res.status(400).json({ error: "title required" });

  let graphId: string | null = null;
  if (userId) {
    const graph = await getGraphForUser(pool, userId);
    if (graph) {
      try {
        const list = await graph.fetch("/me/todo/lists");
        const listsJson = await list.json();
        const defaultList = (listsJson.value ?? []).find((l: any) => l.wellknownListName === "defaultList") ?? listsJson.value?.[0];
        if (defaultList?.id) {
          const create = await graph.fetch(`/me/todo/lists/${defaultList.id}/tasks`, {
            method: "POST",
            body: JSON.stringify({
              title,
              body: body.notes ? { content: body.notes, contentType: "text" } : undefined,
              dueDateTime: body.due_at ? { dateTime: new Date(body.due_at).toISOString(), timeZone: "UTC" } : undefined,
              importance: body.priority === "high" ? "high" : body.priority === "low" ? "low" : "normal",
            }),
          });
          if (create.ok) graphId = (await create.json()).id ?? null;
        }
      } catch {
        graphId = null;
      }
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO crm_tasks
       (title, notes, due_at, reminder_at, task_type, priority, queue_name,
        assigned_to, owner_id, contact_id, company_id, status, graph_id, silo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12,$13)
     RETURNING *`,
    [
      title,
      body.notes ?? null,
      body.due_at ?? null,
      body.reminder_at ?? null,
      body.task_type ?? "todo",
      body.priority ?? "none",
      body.queue ?? null,
      body.assigned_to ?? userId,
      userId,
      contactId,
      companyId,
      graphId,
      silo,
    ],
  );
  res.status(201).json({ ok: true, data: rows[0] });
}));

router.patch("/:taskId", safeHandler(async (req: any, res: any) => {
  const updates: string[] = []; const params: unknown[] = []; let i = 1;
  for (const k of ["title", "notes", "due_at", "reminder_at", "priority", "status", "queue_name", "assigned_to"]) {
    if (k in (req.body ?? {})) { updates.push(`${k} = $${i++}`); params.push(req.body[k]); }
  }
  if (!updates.length) return respondOk(res, null);
  params.push(req.params.taskId);
  params.push(resolveSiloFromRequest(req));
  const { rows } = await pool.query(
    `UPDATE crm_tasks SET ${updates.join(", ")}, updated_at = NOW()
     WHERE id = $${i} AND silo = $${i + 1} RETURNING *`,
    params,
  );
  respondOk(res, rows[0] ?? null);
}));

function resolveScope(req: any): { contactId: string | null; companyId: string | null } {
  const isContact = req.baseUrl?.includes("/contacts/");
  const id = req.params.id;
  return isContact ? { contactId: id, companyId: req.body?.companyId ?? null }
    : { companyId: id, contactId: req.body?.contactId ?? null };
}

export default router;
