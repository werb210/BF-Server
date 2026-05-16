import express from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { respondOk } from "../../utils/respondOk.js";
import { getGraphForUser } from "../../modules/o365/graphClient.js";

const router = express.Router({ mergeParams: true });

router.get("/", safeHandler(async (req: any, res: any) => {
  const { contactId, companyId } = resolveScope(req);
  const silo = resolveSiloFromRequest(req);
  const where: string[] = ["silo = $1"]; const params: unknown[] = [silo];
  if (contactId) { params.push(contactId); where.push(`contact_id = $${params.length}`); }
  if (companyId) { params.push(companyId); where.push(`company_id = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT * FROM crm_meetings WHERE ${where.join(" AND ")}
     ORDER BY start_at DESC LIMIT 200`,
    params,
  );
  respondOk(res, rows);
}));

router.post("/", safeHandler(async (req: any, res: any) => {
  const { contactId, companyId } = resolveScope(req);
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });

  const b = req.body ?? {};
  const title = (b.title ?? "").toString().trim();
  if (!title || !b.start_at || !b.end_at)
    return res.status(400).json({ error: "title, start_at, end_at required" });

  let graphId: string | null = null;
  const graph = await getGraphForUser(pool, userId);
  if (graph) {
    try {
      const create = await graph.fetch("/me/events", {
        method: "POST",
        body: JSON.stringify({
          subject: title,
          body: { contentType: "HTML", content: b.attendee_description ?? "" },
          start: { dateTime: new Date(b.start_at).toISOString(), timeZone: "UTC" },
          end: { dateTime: new Date(b.end_at).toISOString(), timeZone: "UTC" },
          location: b.location ? { displayName: b.location } : undefined,
          attendees: (b.attendees ?? []).map((a: any) => ({
            emailAddress: { address: a.address, name: a.name ?? a.address },
            type: a.optional ? "optional" : "required",
          })),
          reminderMinutesBeforeStart: b.reminder_minutes ?? 60,
        }),
      });
      if (create.ok) graphId = (await create.json()).id ?? null;
    } catch {
      graphId = null;
    }
  }

  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query(
    `INSERT INTO crm_meetings
      (title,attendee_description,internal_note,start_at,end_at,location,
       attendees_json,reminder_minutes,owner_id,contact_id,company_id,graph_id,silo)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      title,
      b.attendee_description ?? null,
      b.internal_note ?? null,
      b.start_at,
      b.end_at,
      b.location ?? null,
      JSON.stringify(b.attendees ?? []),
      b.reminder_minutes ?? 60,
      userId,
      contactId,
      companyId,
      graphId,
      silo,
    ],
  );
  res.status(201).json({ ok: true, data: rows[0] });
}));

function resolveScope(req: any): { contactId: string | null; companyId: string | null } {
  const isContact = req.baseUrl?.includes("/contacts/");
  const id = req.params.id;
  return isContact ? { contactId: id, companyId: req.body?.companyId ?? null }
    : { companyId: id, contactId: req.body?.contactId ?? null };
}

export default router;
