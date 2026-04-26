/**
 * Calendar routes — proxies to Microsoft Graph using the user's stored O365 token.
 * Falls back to empty arrays when the user has not connected O365.
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getSilo } from "../middleware/silo.js";
import { pool } from "../db.js";

const router = Router();

router.use(requireAuth);

type CalendarTaskRow = {
  id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  priority: "low" | "normal" | "high";
  status: "open" | "done";
  o365_task_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

async function getO365Token(userId: string): Promise<string | null> {
  const res = await pool.query<{ o365_access_token: string | null; o365_token_expires_at: Date | null }>(
    "SELECT o365_access_token, o365_token_expires_at FROM users WHERE id = $1 LIMIT 1",
    [userId]
  );
  const row = res.rows[0];
  if (!row?.o365_access_token) return null;
  if (row.o365_token_expires_at) {
    const expiresAt = new Date(row.o365_token_expires_at).getTime();
    if (Date.now() > expiresAt - 5 * 60 * 1000) return null;
  }
  return row.o365_access_token;
}

async function graphGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Graph API error: ${res.status} ${path}`);
  return res.json();
}

async function graphPost(token: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Graph API error: ${res.status} ${path}`);
  return res.json();
}

async function graphPatch(token: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Graph API error: ${res.status} ${path}`);
  return res.json();
}

async function graphDelete(token: string, path: string): Promise<void> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Graph API error: ${res.status} ${path}`);
}

function toTaskResponse(row: CalendarTaskRow) {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    dueAt: row.due_at,
    priority: row.priority,
    status: row.status,
    o365TaskId: row.o365_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function normalizePriority(value: unknown): "low" | "normal" | "high" {
  return value === "low" || value === "high" ? value : "normal";
}

function normalizeStatus(value: unknown): "open" | "done" {
  return value === "done" ? "done" : "open";
}

async function getDefaultTodoListId(token: string): Promise<string | null> {
  const lists = await graphGet(token, "/me/todo/lists?$top=20");
  const allLists = (lists as any).value ?? [];
  const defaultList = allLists.find((l: any) => l.wellknownListName === "defaultList") ?? allLists[0];
  return defaultList?.id ?? null;
}

// GET /api/calendar — summary
router.get("/", safeHandler(async (req: any, res: any) => {
  const token = await getO365Token(req.user?.userId).catch(() => null);
  if (!token) return res.status(200).json({ status: "ok", data: { items: [], connected: false } });
  try {
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const data = await graphGet(token, `/me/calendarView?startDateTime=${now}&endDateTime=${end}&$top=20&$orderby=start/dateTime`);
    const items = (data as any).value ?? [];
    res.status(200).json({ status: "ok", data: { items, connected: true } });
  } catch {
    res.status(200).json({ status: "ok", data: { items: [], connected: true, error: "graph_fetch_failed" } });
  }
}));

// GET /api/calendar/events
router.get("/events", safeHandler(async (req: any, res: any) => {
  const token = await getO365Token(req.user?.userId).catch(() => null);
  if (!token) return res.status(200).json({ status: "ok", data: [] });
  try {
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const data = await graphGet(token, `/me/calendarView?startDateTime=${now}&endDateTime=${end}&$top=50&$orderby=start/dateTime`);
    res.status(200).json({ status: "ok", data: (data as any).value ?? [] });
  } catch {
    res.status(200).json({ status: "ok", data: [] });
  }
}));

// POST /api/calendar/events
router.post("/events", safeHandler(async (req: any, res: any) => {
  const token = await getO365Token(req.user?.userId).catch(() => null);
  if (!token) {
    const id = randomUUID();
    return res.status(201).json({ status: "ok", data: { id, ...req.body } });
  }
  const body = req.body ?? {};
  const event = await graphPost(token, "/me/events", {
    subject: body.title ?? body.subject ?? "Untitled Event",
    start: { dateTime: body.start ?? body.startDateTime ?? new Date().toISOString(), timeZone: "UTC" },
    end: { dateTime: body.end ?? body.endDateTime ?? new Date(Date.now() + 3600000).toISOString(), timeZone: "UTC" },
    ...(body.description ? { body: { contentType: "text", content: body.description } } : {}),
    ...(body.attendees ? { attendees: body.attendees } : {}),
  });
  res.status(201).json({ status: "ok", data: event });
}));

// PATCH /api/calendar/events/:id
router.patch("/events/:id", safeHandler(async (req: any, res: any) => {
  const token = await getO365Token(req.user?.userId).catch(() => null);
  const { id } = req.params as { id: string };
  if (!token) return res.status(200).json({ status: "ok", data: { id, ...req.body } });
  const body = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (body.title ?? body.subject) patch.subject = body.title ?? body.subject;
  if (body.start ?? body.startDateTime) patch.start = { dateTime: body.start ?? body.startDateTime, timeZone: "UTC" };
  if (body.end ?? body.endDateTime) patch.end = { dateTime: body.end ?? body.endDateTime, timeZone: "UTC" };
  if (body.description) patch.body = { contentType: "text", content: body.description };
  const event = await graphPatch(token, `/me/events/${id}`, patch);
  res.status(200).json({ status: "ok", data: event });
}));

// DELETE /api/calendar/events/:id
router.delete("/events/:id", safeHandler(async (req: any, res: any) => {
  const token = await getO365Token(req.user?.userId).catch(() => null);
  const { id } = req.params as { id: string };
  if (!token) return res.status(200).json({ status: "ok", data: null });
  await graphDelete(token, `/me/events/${id}`);
  res.status(200).json({ status: "ok", data: null });
}));

// GET /api/calendar/tasks
router.get("/tasks", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const silo = getSilo(res);
  const status = String(req.query.status ?? "all");
  const dueBefore = typeof req.query.dueBefore === "string" ? req.query.dueBefore : null;
  const dueAfter = typeof req.query.dueAfter === "string" ? req.query.dueAfter : null;

  const clauses = ["user_id = $1", "silo = $2"];
  const params: unknown[] = [userId, silo];

  if (status === "open" || status === "done") {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  if (dueBefore) {
    params.push(dueBefore);
    clauses.push(`due_at <= $${params.length}::timestamptz`);
  }
  if (dueAfter) {
    params.push(dueAfter);
    clauses.push(`due_at >= $${params.length}::timestamptz`);
  }

  const { rows } = await pool.query<CalendarTaskRow>(
    `SELECT id, title, notes, due_at, priority, status, o365_task_id, created_at, updated_at, completed_at
       FROM calendar_tasks
      WHERE ${clauses.join(" AND ")}
      ORDER BY COALESCE(due_at, '9999-12-31'::timestamptz) ASC, created_at DESC`,
    params,
  );

  res.status(200).json(rows.map(toTaskResponse));
}));

// POST /api/calendar/tasks
router.post("/tasks", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const silo = getSilo(res);
  const body = req.body ?? {};
  const title = String(body.title ?? "").trim();
  if (!title) return res.status(400).json({ error: "title is required" });
  if (title.length > 500) return res.status(400).json({ error: "title too long" });

  const priority = normalizePriority(body.priority);
  const status = normalizeStatus(body.status);
  const dueAt = body.dueAt ?? null;
  const notes = body.notes ?? null;

  const { rows } = await pool.query<CalendarTaskRow>(
    `INSERT INTO calendar_tasks (user_id, silo, title, notes, due_at, priority, status, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, title, notes, due_at, priority, status, o365_task_id, created_at, updated_at, completed_at`,
    [userId, silo, title, notes, dueAt, priority, status, status === "done" ? new Date().toISOString() : null],
  );
  const row = rows[0];

  const token = await getO365Token(userId).catch(() => null);
  if (token) {
    try {
      const listId = await getDefaultTodoListId(token);
      if (listId) {
        const graphTask = await graphPost(token, `/me/todo/lists/${listId}/tasks`, {
          title,
          body: notes ? { content: String(notes), contentType: "text" } : undefined,
          dueDateTime: dueAt ? { dateTime: new Date(dueAt).toISOString(), timeZone: "UTC" } : undefined,
          importance: priority,
          status: status === "done" ? "completed" : "notStarted",
        });
        const graphId = (graphTask as any)?.id;
        if (graphId) {
          const updated = await pool.query<CalendarTaskRow>(
            `UPDATE calendar_tasks
                SET o365_task_id = $1, updated_at = NOW()
              WHERE id = $2 AND user_id = $3 AND silo = $4
            RETURNING id, title, notes, due_at, priority, status, o365_task_id, created_at, updated_at, completed_at`,
            [graphId, row.id, userId, silo],
          );
          return res.status(201).json(toTaskResponse(updated.rows[0] ?? row));
        }
      }
    } catch (err) {
      console.error({ event: "calendar_task_graph_create_error", err: String(err) });
    }
  }

  return res.status(201).json(toTaskResponse(row));
}));

// PATCH /api/calendar/tasks/:id
router.patch("/tasks/:id", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const silo = getSilo(res);

  const current = await pool.query<CalendarTaskRow>(
    `SELECT id, title, notes, due_at, priority, status, o365_task_id, created_at, updated_at, completed_at
       FROM calendar_tasks
      WHERE id = $1 AND user_id = $2 AND silo = $3
      LIMIT 1`,
    [req.params.id, userId, silo],
  );
  const row = current.rows[0];
  if (!row) return res.status(404).json({ error: "not_found" });

  const body = req.body ?? {};
  const updates: string[] = [];
  const params: unknown[] = [];

  if (typeof body.title !== "undefined") {
    const title = String(body.title ?? "").trim();
    if (!title) return res.status(400).json({ error: "title is required" });
    if (title.length > 500) return res.status(400).json({ error: "title too long" });
    params.push(title);
    updates.push(`title = $${params.length}`);
  }
  if (typeof body.notes !== "undefined") {
    params.push(body.notes ?? null);
    updates.push(`notes = $${params.length}`);
  }
  if (typeof body.dueAt !== "undefined") {
    params.push(body.dueAt ?? null);
    updates.push(`due_at = $${params.length}`);
  }
  if (typeof body.priority !== "undefined") {
    params.push(normalizePriority(body.priority));
    updates.push(`priority = $${params.length}`);
  }

  let nextStatus = row.status;
  if (typeof body.status !== "undefined") {
    nextStatus = normalizeStatus(body.status);
    params.push(nextStatus);
    updates.push(`status = $${params.length}`);
  }

  if (row.status !== nextStatus) {
    updates.push(`completed_at = ${nextStatus === "done" ? "NOW()" : "NULL"}`);
  }

  updates.push("updated_at = NOW()");
  params.push(req.params.id, userId, silo);
  const { rows } = await pool.query<CalendarTaskRow>(
    `UPDATE calendar_tasks SET ${updates.join(", ")}
      WHERE id = $${params.length - 2} AND user_id = $${params.length - 1} AND silo = $${params.length}
      RETURNING id, title, notes, due_at, priority, status, o365_task_id, created_at, updated_at, completed_at`,
    params,
  );

  const updated = rows[0];

  const token = await getO365Token(userId).catch(() => null);
  if (token && updated?.o365_task_id) {
    try {
      const listId = await getDefaultTodoListId(token);
      if (listId) {
        await graphPatch(token, `/me/todo/lists/${listId}/tasks/${updated.o365_task_id}`, {
          title: updated.title,
          body: updated.notes ? { content: updated.notes, contentType: "text" } : undefined,
          dueDateTime: updated.due_at ? { dateTime: new Date(updated.due_at).toISOString(), timeZone: "UTC" } : null,
          importance: updated.priority,
          status: updated.status === "done" ? "completed" : "notStarted",
        });
      }
    } catch (err) {
      console.error({ event: "calendar_task_graph_patch_error", err: String(err) });
    }
  }

  return res.status(200).json(toTaskResponse(updated));
}));

// DELETE /api/calendar/tasks/:id
router.delete("/tasks/:id", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const silo = getSilo(res);

  const { rows } = await pool.query<{ o365_task_id: string | null }>(
    `DELETE FROM calendar_tasks
      WHERE id = $1 AND user_id = $2 AND silo = $3
      RETURNING o365_task_id`,
    [req.params.id, userId, silo],
  );

  const o365TaskId = rows[0]?.o365_task_id ?? null;
  const token = await getO365Token(userId).catch(() => null);
  if (token && o365TaskId) {
    try {
      const listId = await getDefaultTodoListId(token);
      if (listId) {
        await graphDelete(token, `/me/todo/lists/${listId}/tasks/${o365TaskId}`);
      }
    } catch (err) {
      console.error({ event: "calendar_task_graph_delete_error", err: String(err) });
    }
  }

  return res.status(200).json({ ok: true });
}));

export default router;
