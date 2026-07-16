/**
 * Calendar routes — proxies to Microsoft Graph using the user's stored O365 token.
 * Falls back to empty arrays when the user has not connected O365.
 */
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getSilo } from "../middleware/silo.js";
import { pool } from "../db.js";
import { getGraphForUser, type GraphClient } from "../modules/o365/graphClient.js";

const router = Router();

router.use(requireAuth);

type CalendarTaskRow = {
  id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  priority: "low" | "normal" | "high";
  status: "open" | "done";
  assignee_user_id: string | null;
  o365_task_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

// BF_SERVER_BLOCK_v649_SHOWSTOPPER_PATCHES_v1 — preserve the upstream
// Graph status so the route can return 4xx as 4xx (not blanket 500).
class GraphError extends Error {
  status: number;
  bodyText: string;
  path: string;
  constructor(status: number, bodyText: string, path: string) {
    super(`Graph API error: ${status} ${path}`);
    this.status = status;
    this.bodyText = bodyText;
    this.path = path;
  }
}

async function graphCall(graph: GraphClient, path: string, init?: RequestInit): Promise<any> {
  const resp = await graph.fetch(path, init);
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    throw new GraphError(resp.status, bodyText, path);
  }
  if (resp.status === 204) return null; // DELETE returns no body
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

// BF_SERVER_BLOCK_v649_SHOWSTOPPER_PATCHES_v1 — flatten a Microsoft Graph
// calendar event into the {id,title,start,end,location,...} shape the
// BF-portal calendar grid expects. Graph events nest start/end into
// {dateTime,timeZone}; the portal expected plain strings, which is why
// newly-created events vanished from the grid even when the POST succeeded.
function normalizeGraphEvent(ev: any): {
  id?: string;
  title?: string;
  start?: string;
  end?: string;
  location?: string;
  attendees?: string[];
  notes?: string;
  teamsLink?: string | null;
  webLink?: string | null;
} {
  const startDt =
    typeof ev?.start === "string"
      ? ev.start
      : ev?.start?.dateTime ?? undefined;
  const endDt =
    typeof ev?.end === "string"
      ? ev.end
      : ev?.end?.dateTime ?? undefined;
  const attendeesRaw = Array.isArray(ev?.attendees) ? ev.attendees : [];
  const attendees: string[] = attendeesRaw
    .map((a: any) => a?.emailAddress?.address ?? a?.email ?? "")
    .filter((s: string) => !!s);
  return {
    id: ev?.id,
    title: ev?.subject ?? ev?.title ?? "Untitled",
    start: startDt,
    end: endDt,
    location:
      typeof ev?.location === "string"
        ? ev.location
        : ev?.location?.displayName ?? "",
    attendees,
    notes:
      typeof ev?.body === "string"
        ? ev.body
        : ev?.body?.content ?? ev?.bodyPreview ?? "",
    teamsLink: ev?.onlineMeeting?.joinUrl ?? null,
    webLink: ev?.webLink ?? null,
  };
}

// BF_SERVER_BLOCK_v649_SHOWSTOPPER_PATCHES_v1 — surface Graph 4xx as 4xx
// (e.g. 400 for invalid end<start). Anything else stays a 500 — the
// previous behavior of swallowing every Graph failure as a server error
// hid useful validation feedback from the staff portal.
function relayGraphFailure(res: any, err: unknown): boolean {
  if (err instanceof GraphError && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({
      status: "error",
      code: "graph_client_error",
      message: err.message,
      details: err.bodyText?.slice(0, 1000) ?? "",
    });
    return true;
  }
  return false;
}

function toTaskResponse(row: CalendarTaskRow) {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    dueAt: row.due_at,
    priority: row.priority,
    status: row.status,
    assigneeUserId: row.assignee_user_id,
    assignee_user_id: row.assignee_user_id,
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

async function getDefaultTodoListId(graph: GraphClient): Promise<string | null> {
  const lists = await graphCall(graph, "/me/todo/lists?$top=20");
  const allLists = lists?.value ?? [];
  const defaultList = allLists.find((l: any) => l.wellknownListName === "defaultList") ?? allLists[0];
  return defaultList?.id ?? null;
}

// BF_SERVER_BLOCK_v685_CALENDAR_WINDOW_v1 — the calendar grid asks for a
// specific visible range; honor ?start=&end= when present, otherwise default
// to a window that STARTS IN THE PAST so events earlier today (created before
// the current instant) still return. The previous startDateTime=now silently
// dropped any event whose start was before "now" — which is exactly why a
// freshly-created event vanished from the grid the moment it was saved.
function calendarWindow(req: any): { start: string; end: string } {
  const DAY = 24 * 3600 * 1000;
  const parse = (v: unknown): Date | null => {
    if (typeof v !== "string" || !v.trim()) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  let start = parse(req?.query?.start) ?? new Date(Date.now() - 7 * DAY);
  let end = parse(req?.query?.end) ?? new Date(Date.now() + 60 * DAY);
  if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + DAY);
  const MAX_SPAN = 400 * DAY; // bound Graph load
  if (end.getTime() - start.getTime() > MAX_SPAN) end = new Date(start.getTime() + MAX_SPAN);
  return { start: start.toISOString(), end: end.toISOString() };
}

// GET /api/calendar — summary
router.get("/", safeHandler(async (req: any, res: any) => {
  const graph = await getGraphForUser(pool, req.user?.userId).catch(() => null);
  if (!graph) return res.status(200).json({ status: "ok", data: { items: [], connected: false } });
  try {
    const { start, end } = calendarWindow(req); // BF_SERVER_BLOCK_v685_CALENDAR_WINDOW_v1
    const data = await graphCall(graph, `/me/calendarView?startDateTime=${start}&endDateTime=${end}&$top=200&$orderby=start/dateTime`);
    const items = (data as any).value ?? [];
    res.status(200).json({ status: "ok", data: { items, connected: true } });
  } catch {
    res.status(200).json({ status: "ok", data: { items: [], connected: true, error: "graph_fetch_failed" } });
  }
}));

// GET /api/calendar/events
// BF_SERVER_BLOCK_v649_SHOWSTOPPER_PATCHES_v1 — flatten Graph event shape
// so the portal calendar grid actually renders.
router.get("/events", safeHandler(async (req: any, res: any) => {
  const graph = await getGraphForUser(pool, req.user?.userId).catch(() => null);
  if (!graph) return res.status(200).json({ status: "ok", data: [] });
  try {
    const { start, end } = calendarWindow(req); // BF_SERVER_BLOCK_v685_CALENDAR_WINDOW_v1
    const data = await graphCall(graph, `/me/calendarView?startDateTime=${start}&endDateTime=${end}&$top=200&$orderby=start/dateTime`);
    const raw: any[] = Array.isArray((data as any)?.value) ? (data as any).value : [];
    res.status(200).json({ status: "ok", data: raw.map(normalizeGraphEvent) });
  } catch {
    res.status(200).json({ status: "ok", data: [] });
  }
}));

// BF_SERVER_CALENDAR_ATTENDEES_v1 - the Add Event form sends `attendees` as a comma string
// (or omits it). Graph requires an array of { emailAddress:{address}, type }. Normalize a
// string, an array of strings, or an array of {emailAddress|email} objects into that shape.
function toGraphAttendees(raw: any): Array<{ emailAddress: { address: string }; type: string }> {
  let list: string[] = [];
  if (Array.isArray(raw)) {
    list = raw.map((a: any) => (typeof a === "string" ? a : (a?.emailAddress?.address ?? a?.email ?? ""))).filter(Boolean);
  } else if (typeof raw === "string") {
    list = raw.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  }
  const seen = new Set<string>();
  const out: Array<{ emailAddress: { address: string }; type: string }> = [];
  for (const e of list) {
    const addr = String(e).trim();
    if (!addr || !addr.includes("@")) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ emailAddress: { address: addr }, type: "required" });
  }
  return out;
}

// POST /api/calendar/events
// BF_SERVER_BLOCK_v649_SHOWSTOPPER_PATCHES_v1 — propagate Graph 4xx and
// return the event in the same flat shape as GET so the portal cache
// invalidation refetch lands on the right structure.
router.post("/events", safeHandler(async (req: any, res: any) => {
  const graph = await getGraphForUser(pool, req.user?.userId).catch(() => null);
  if (!graph) return res.status(412).json({ status: "error", code: "o365_not_connected", message: "Connect Microsoft 365 to save calendar events." });
  const body = req.body ?? {};
  const graphAttendees = toGraphAttendees(body.attendees); // BF_SERVER_CALENDAR_ATTENDEES_v1
  try {
    const event = await graphCall(graph, "/me/events", {
      method: "POST",
      body: JSON.stringify({
      subject: body.title ?? body.subject ?? "Untitled Event",
      start: { dateTime: body.start ?? body.startDateTime ?? new Date().toISOString(), timeZone: "UTC" },
      end: { dateTime: body.end ?? body.endDateTime ?? new Date(Date.now() + 3600000).toISOString(), timeZone: "UTC" },
      // BF_SERVER_CALENDAR_NOTES_LOCATION_v1 - the Add Event form sends `notes` and
      // `location`; map them onto the Graph event (notes -> body, location -> displayName).
      // Accept `description` too for any older callers.
      ...((body.notes ?? body.description) ? { body: { contentType: "text", content: body.notes ?? body.description } } : {}),
      ...(body.location ? { location: { displayName: body.location } } : {}),
      ...(graphAttendees.length ? { attendees: graphAttendees } : {}),
      }),
    });
    // BF_SERVER_BLOCK_v734 — channel-level meeting logging. A calendar event
    // created here is logged to crm_meetings for every attendee that resolves
    // to a CRM contact (by email, within the request's silo), so meetings
    // booked from the Calendar page appear on the contact timeline in BOTH
    // BF and BI. Best-effort; never blocks the event response.
    try {
      let _silo: string = "BF";
      try { _silo = getSilo(res); } catch { _silo = "BF"; }
      const _emails = Array.from(new Set((Array.isArray(body.attendees) ? body.attendees : [])
        .map((a: any) => (a?.emailAddress?.address ?? a?.email ?? (typeof a === "string" ? a : "")))
        .map((e: any) => String(e || "").trim().toLowerCase()).filter(Boolean)));
      if (_emails.length) {
        const _m = await pool.query(
          `SELECT id FROM contacts WHERE silo = $1 AND lower(email) = ANY($2::text[])`,
          [_silo, _emails],
        );
        for (const _row of _m.rows) {
          await pool.query(
            `INSERT INTO crm_meetings
               (title,attendee_description,internal_note,start_at,end_at,location,
                attendees_json,reminder_minutes,owner_id,contact_id,company_id,graph_id,silo)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)`,
            [
              body.title ?? body.subject ?? "Untitled Event",
              _emails.join(", "),
              null,
              body.start ?? body.startDateTime ?? null,
              body.end ?? body.endDateTime ?? null,
              body.location ?? null,
              JSON.stringify(body.attendees ?? []),
              60,
              req.user?.userId ?? null,
              _row.id,
              null,
              (event as any)?.id ?? null,
              _silo,
            ],
          );
        }
      }
    } catch (_e) { /* never block the event response on logging */ }
    res.status(201).json({ status: "ok", data: normalizeGraphEvent(event) });
  } catch (err) {
    if (relayGraphFailure(res, err)) return;
    throw err;
  }
}));

// PATCH /api/calendar/events/:id
router.patch("/events/:id", safeHandler(async (req: any, res: any) => {
  const graph = await getGraphForUser(pool, req.user?.userId).catch(() => null);
  const { id } = req.params as { id: string };
  if (!graph) return res.status(412).json({ status: "error", code: "o365_not_connected", message: "Connect Microsoft 365 to edit calendar events." });
  const body = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (body.title ?? body.subject) patch.subject = body.title ?? body.subject;
  if (body.start ?? body.startDateTime) patch.start = { dateTime: body.start ?? body.startDateTime, timeZone: "UTC" };
  if (body.end ?? body.endDateTime) patch.end = { dateTime: body.end ?? body.endDateTime, timeZone: "UTC" };
  if (body.description) patch.body = { contentType: "text", content: body.description };
  try {
    const event = await graphCall(graph, `/me/events/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    res.status(200).json({ status: "ok", data: event });
  } catch (err) {
    if (relayGraphFailure(res, err)) return;
    throw err;
  }
}));

// DELETE /api/calendar/events/:id
router.delete("/events/:id", safeHandler(async (req: any, res: any) => {
  const graph = await getGraphForUser(pool, req.user?.userId).catch(() => null);
  const { id } = req.params as { id: string };
  if (!graph) return res.status(412).json({ status: "error", code: "o365_not_connected", message: "Connect Microsoft 365 to delete calendar events." });
  try {
    await graphCall(graph, `/me/events/${id}`, { method: "DELETE" });
    res.status(200).json({ status: "ok", data: null });
  } catch (err) {
    if (relayGraphFailure(res, err)) return;
    throw err;
  }
}));

// BF_SERVER_BLOCK_v332_UNIFY_TASKS_v1 — tasks unified onto crm_tasks (one table)
// GET /api/calendar/tasks
router.get("/tasks", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const silo = getSilo(res);
  const status = String(req.query.status ?? "all");
  const dueBefore = typeof req.query.dueBefore === "string" ? req.query.dueBefore : null;
  const dueAfter = typeof req.query.dueAfter === "string" ? req.query.dueAfter : null;

  const clauses = ["(t.assigned_to = $1 OR t.owner_id = $1)", "t.silo = $2"];
  const params: unknown[] = [userId, silo];

  if (status === "open" || status === "done") {
    params.push(status);
    clauses.push(`t.status = $${params.length}`);
  }
  if (dueBefore) {
    params.push(dueBefore);
    clauses.push(`t.due_at <= $${params.length}::timestamptz`);
  }
  if (dueAfter) {
    params.push(dueAfter);
    clauses.push(`t.due_at >= $${params.length}::timestamptz`);
  }

  const { rows } = await pool.query<CalendarTaskRow>(
    `SELECT t.id, t.title, t.notes, t.due_at, t.priority, t.status, t.assigned_to AS assignee_user_id, t.graph_id AS o365_task_id, t.created_at, t.updated_at, t.completed_at,
      COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email) as assignee_name, u.email as assignee_email
       FROM crm_tasks t
      LEFT JOIN users u ON u.id = t.assigned_to
      WHERE ${clauses.join(" AND ")}
      ORDER BY COALESCE(t.due_at, '9999-12-31'::timestamptz) ASC, t.created_at DESC`,
    params,
  );

  res.status(200).json(rows.map((row: any) => { const task: any = toTaskResponse(row); task.due_date = task.dueAt; task.assignee_name = row.assignee_name ?? null; task.assignee_email = row.assignee_email ?? null; return task; }));
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
  const dueAt = typeof body.dueAt === "string" ? (body.dueAt.trim().length > 0 ? body.dueAt : null) : (body.dueAt ?? null);
  const notes = body.notes ?? null;
  const assigneeUserId = typeof body.assignee_user_id === "string" && body.assignee_user_id.trim().length > 0 ? body.assignee_user_id : null;

  const { rows } = await pool.query<CalendarTaskRow>(
    `INSERT INTO crm_tasks (owner_id, silo, title, notes, due_at, priority, status, completed_at, assigned_to, task_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'todo')
     RETURNING id, title, notes, due_at, priority, status, assigned_to AS assignee_user_id, graph_id AS o365_task_id, created_at, updated_at, completed_at`,
    [userId, silo, title, notes, dueAt, priority, status, status === "done" ? new Date().toISOString() : null, assigneeUserId],
  );
  const row = rows[0];

  const graph = await getGraphForUser(pool, userId).catch(() => null);
  if (graph) {
    try {
      const listId = await getDefaultTodoListId(graph);
      if (listId) {
        const graphTask = await graphCall(graph, `/me/todo/lists/${listId}/tasks`, {
          method: "POST",
          body: JSON.stringify({
          title,
          body: notes ? { content: String(notes), contentType: "text" } : undefined,
          dueDateTime: dueAt ? { dateTime: new Date(dueAt).toISOString(), timeZone: "UTC" } : undefined,
          importance: (priority === "low" || priority === "high") ? priority : "normal", // v343_TODO_IMPORTANCE
          status: status === "done" ? "completed" : "notStarted",
          }),
        });
        const graphId = (graphTask as any)?.id;
        if (graphId) {
          const updated = await pool.query<CalendarTaskRow>(
            `UPDATE crm_tasks
                SET graph_id = $1, updated_at = NOW()
              WHERE id = $2 AND owner_id = $3 AND silo = $4
            RETURNING id, title, notes, due_at, priority, status, assigned_to AS assignee_user_id, graph_id AS o365_task_id, created_at, updated_at, completed_at`,
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
    `SELECT id, title, notes, due_at, priority, status, assigned_to AS assignee_user_id, graph_id AS o365_task_id, created_at, updated_at, completed_at
       FROM crm_tasks
      WHERE id = $1 AND owner_id = $2 AND silo = $3
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
    const dueAt = typeof body.dueAt === "string" ? (body.dueAt.trim().length > 0 ? body.dueAt : null) : (body.dueAt ?? null);
    params.push(dueAt);
    updates.push(`due_at = $${params.length}`);
  }
  if (typeof body.assignee_user_id !== "undefined") {
    const assigneeUserId = typeof body.assignee_user_id === "string" && body.assignee_user_id.trim().length > 0 ? body.assignee_user_id : null;
    params.push(assigneeUserId);
    updates.push(`assigned_to = $${params.length}`);
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
    `UPDATE crm_tasks SET ${updates.join(", ")}
      WHERE id = $${params.length - 2} AND owner_id = $${params.length - 1} AND silo = $${params.length}
      RETURNING id, title, notes, due_at, priority, status, assigned_to AS assignee_user_id, graph_id AS o365_task_id, created_at, updated_at, completed_at`,
    params,
  );

  const updated = rows[0];

  const graph = await getGraphForUser(pool, userId).catch(() => null);
  if (graph && updated?.o365_task_id) {
    try {
      const listId = await getDefaultTodoListId(graph);
      if (listId) {
        await graphCall(graph, `/me/todo/lists/${listId}/tasks/${updated.o365_task_id}`, {
          method: "PATCH",
          body: JSON.stringify({
          title: updated.title,
          body: updated.notes ? { content: updated.notes, contentType: "text" } : undefined,
          dueDateTime: updated.due_at ? { dateTime: new Date(updated.due_at).toISOString(), timeZone: "UTC" } : undefined, // v343_TODO_IMPORTANCE
          importance: (updated.priority === "low" || updated.priority === "high") ? updated.priority : "normal", // v343_TODO_IMPORTANCE
          status: updated.status === "done" ? "completed" : "notStarted",
          }),
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
    `DELETE FROM crm_tasks
      WHERE id = $1 AND owner_id = $2 AND silo = $3
      RETURNING graph_id AS o365_task_id`,
    [req.params.id, userId, silo],
  );

  const o365TaskId = rows[0]?.o365_task_id ?? null;
  const graph = await getGraphForUser(pool, userId).catch(() => null);
  if (graph && o365TaskId) {
    try {
      const listId = await getDefaultTodoListId(graph);
      if (listId) {
        await graphCall(graph, `/me/todo/lists/${listId}/tasks/${o365TaskId}`, { method: "DELETE" });
      }
    } catch (err) {
      console.error({ event: "calendar_task_graph_delete_error", err: String(err) });
    }
  }

  return res.status(200).json({ ok: true });
}));

// BF_SERVER_BLOCK_v_SHARED_CALENDAR_v1 - free/busy across staff (getSchedule) and
// view a teammate's calendar (needs Calendars.Read.Shared).
router.get("/schedule", safeHandler(async (req: any, res: any) => {
  const graph = await getGraphForUser(pool, req.user?.userId).catch(() => null);
  if (!graph) return res.status(200).json({ status: "ok", data: { schedules: [], connected: false } });
  const emails = String(req.query.emails ?? "").split(",").map((e: string) => e.trim()).filter(Boolean).slice(0, 20);
  if (!emails.length) return res.status(400).json({ status: "error", error: "emails required" });
  const { start, end } = calendarWindow(req);
  try {
    const data = await graphCall(graph, "/me/calendar/getSchedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schedules: emails,
        startTime: { dateTime: start, timeZone: "UTC" },
        endTime: { dateTime: end, timeZone: "UTC" },
        availabilityViewInterval: 30,
      }),
    });
    res.status(200).json({ status: "ok", data: { schedules: (data as any).value ?? [], connected: true } });
  } catch {
    res.status(200).json({ status: "ok", data: { schedules: [], connected: true, error: "graph_fetch_failed" } });
  }
}));

router.get("/teammate", safeHandler(async (req: any, res: any) => {
  const graph = await getGraphForUser(pool, req.user?.userId).catch(() => null);
  if (!graph) return res.status(200).json({ status: "ok", data: [] });
  const email = String(req.query.email ?? "").trim();
  if (!email) return res.status(400).json({ status: "error", error: "email required" });
  const { start, end } = calendarWindow(req);
  try {
    const data = await graphCall(graph, `/users/${encodeURIComponent(email)}/calendarView?startDateTime=${start}&endDateTime=${end}&$top=200&$orderby=start/dateTime`);
    const raw: any[] = Array.isArray((data as any)?.value) ? (data as any).value : [];
    res.status(200).json({ status: "ok", data: raw.map(normalizeGraphEvent) });
  } catch {
    res.status(200).json({ status: "ok", data: [] });
  }
}));

export default router;
