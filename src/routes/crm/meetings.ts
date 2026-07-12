import express from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { respondOk } from "../../utils/respondOk.js";
import { getGraphForUser } from "../../modules/o365/graphClient.js";
// BF_SERVER_BLOCK_BI_ROUND5_CRM_SILO_RESOLVE_v1
import { resolveSiloFromRequest } from "../../middleware/silo.js";
import { bumpBiOutreachToDemoBooked } from "../../services/biOutreach.js"; // BF_SERVER_BLOCK_v744

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
  // BF_SERVER_BLOCK_v336_TEAMS_MEETING_v1 — create a real Teams online meeting + capture link
  let joinUrl: string | null = null;
  let organizerUpn: string | null = null; // BF_SERVER_TEAMS_MEETING_LINK_v1
  const wantsOnline = b.online === true || b.meeting_type === "teams";
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
          ...(wantsOnline ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
        }),
      });
      if (create.ok) {
        const j: any = await create.json();
        graphId = j.id ?? null;
        joinUrl = j.onlineMeeting?.joinUrl ?? null;
      }
    } catch {
      graphId = null;
    }
    // BF_SERVER_TEAMS_MEETING_LINK_v1 - the Graph transcript + recording
    // endpoints are addressed as /users/{organizerId}/onlineMeetings/... , so
    // knowing the event id alone is not enough: we must also know WHO organised
    // it. crm_meetings stores neither pairing, so capture the organiser's UPN
    // here while we still hold their delegated Graph client.
    if (wantsOnline && graphId) {
      try {
        const meRes = await graph.fetch("/me?$select=userPrincipalName");
        if (meRes.ok) {
          const meJson: any = await meRes.json();
          organizerUpn = meJson?.userPrincipalName ?? null;
        }
      } catch {
        organizerUpn = null;
      }
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
      joinUrl ?? b.location ?? null, // BF_SERVER_BLOCK_v336_TEAMS_MEETING_v1
      JSON.stringify(b.attendees ?? []),
      b.reminder_minutes ?? 60,
      userId,
      contactId,
      companyId,
      graphId,
      silo,
    ],
  );
  // BF_SERVER_TEAMS_MEETING_LINK_v1 - register the online meeting so the
  // transcript/recording poller can find it after it ends and attach the
  // artifacts (recording link, transcript, Maya summary) to this contact's CRM
  // timeline. Best-effort: a failure here must never break scheduling.
  if (wantsOnline && graphId) {
    try {
      await pool.query(
        `INSERT INTO teams_meetings
           (silo, contact_id, company_id, crm_meeting_id, organizer_user_id, organizer_upn,
            subject, graph_event_id, join_url, scheduled_at, scheduled_end_at, status)
         VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11, 'scheduled')
         ON CONFLICT (graph_event_id) DO UPDATE
           SET subject = EXCLUDED.subject,
               join_url = EXCLUDED.join_url,
               scheduled_at = EXCLUDED.scheduled_at,
               scheduled_end_at = EXCLUDED.scheduled_end_at,
               organizer_upn = COALESCE(EXCLUDED.organizer_upn, teams_meetings.organizer_upn),
               updated_at = now()`,
        [
          silo,
          contactId,
          companyId,
          rows[0]?.id ?? null,
          userId,
          organizerUpn,
          title,
          graphId,
          joinUrl,
          b.start_at,
          b.end_at,
        ],
      );
    } catch (e: any) {
      // BF_SERVER_TEAMS_MEETINGS_UPSERT_FIX_v1 - this used to be a bare
      // `catch {}`. The upsert was failing on every call (partial-index
      // inference) and the silent catch meant teams_meetings stayed empty with
      // no trace in the logs. Scheduling still must not break, but the failure
      // has to be VISIBLE.
      console.error("teams_meeting_register_failed", {
        message: e?.message,
        graph_event_id: graphId,
      });
    }
  }

  if (contactId) void bumpBiOutreachToDemoBooked(String(contactId)); // BF_SERVER_BLOCK_v744
  res.status(201).json({ ok: true, data: rows[0] });
}));

function resolveScope(req: any): { contactId: string | null; companyId: string | null } {
  const isContact = req.baseUrl?.includes("/contacts/");
  const id = req.params.id;
  return isContact ? { contactId: id, companyId: req.body?.companyId ?? null }
    : { companyId: id, contactId: req.body?.contactId ?? null };
}

export default router;
