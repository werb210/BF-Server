// BF_SERVER_MEETING_ROOMS_v736 - conference rooms with access codes.
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { createRoom, roomBySlug, inviteText, joinUrl, oneTapDial, isOpen, DIAL_IN_DISPLAY, type MeetingRoom } from "../services/meetingRooms.js";

const router = Router();
const staff = [requireAuth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const view = (r: MeetingRoom) => ({ ...r, joinUrl: joinUrl(r.slug), oneTap: oneTapDial(r.code), invite: inviteText(r), dialIn: DIAL_IN_DISPLAY, open: isOpen(r) });

export function joinPageHtml(r: MeetingRoom | null): string {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Boreal meeting</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f8fc;color:#0B1F3A}main{max-width:520px;margin:48px auto;padding:28px;background:#fff;border:1px solid #E4EAF2;border-radius:12px}
h1{font-size:22px;margin:0 0 6px}.muted{color:#51617D}.code{font-size:34px;font-weight:700;letter-spacing:4px;margin:6px 0 18px}a.btn{display:inline-block;background:#0B1F3A;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:600;margin:6px 8px 0 0}a.sec{background:#fff;color:#0B1F3A;border:1px solid #E4EAF2}</style></head><body><main>`;
  if (!r || r.status === "cancelled") return head + `<h1>This meeting isn't available</h1><p class="muted">It may have been cancelled. Please contact Boreal Financial at ${esc(DIAL_IN_DISPLAY)}.</p></main></body></html>`;
  const when = new Date(r.starts_at).toLocaleString("en-CA", { timeZone: "America/Edmonton", dateStyle: "full", timeStyle: "short" });
  return head + `<p class="muted">Boreal Financial meeting</p><h1>${esc(r.title)}</h1><p class="muted">${esc(when)} (Mountain time)</p>
<p>Call <strong>${esc(DIAL_IN_DISPLAY)}</strong>, press <strong>3</strong>, then enter this access code and press #:</p><div class="code">${esc(r.code)}</div>
<a class="btn" href="tel:${esc(oneTapDial(r.code))}">Call and join</a><a class="btn sec" href="${esc(joinUrl(r.slug))}/ics">Add to calendar</a>
<p class="muted" style="margin-top:18px;font-size:13px">The room opens 15 minutes before the start time. This call may be recorded.</p></main></body></html>`;
}

export function icsFor(r: MeetingRoom): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/[.][0-9]{3}/, "");
  const start = new Date(r.starts_at);
  const end = new Date(start.getTime() + r.duration_min * 60_000);
  const nl = String.fromCharCode(13) + String.fromCharCode(10);
  const desc = inviteText(r).split(String.fromCharCode(10)).join(" / ");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Boreal Financial//Meetings//EN", "BEGIN:VEVENT",
    "UID:" + r.id + "@boreal.financial", "DTSTAMP:" + fmt(new Date()), "DTSTART:" + fmt(start), "DTEND:" + fmt(end),
    "SUMMARY:" + r.title.replace(/[,;]/g, " "), "LOCATION:Phone " + DIAL_IN_DISPLAY + " option 3 code " + r.code,
    "DESCRIPTION:" + desc.replace(/[,;]/g, " "), "END:VEVENT", "END:VCALENDAR"].join(nl) + nl;
}

router.get("/join/:slug", safeHandler(async (req: any, res: any) => {
  const room = await roomBySlug(req.params.slug);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(room ? 200 : 404).send(joinPageHtml(room));
}));
router.get("/join/:slug/ics", safeHandler(async (req: any, res: any) => {
  const room = await roomBySlug(req.params.slug);
  if (!room || room.status === "cancelled") { res.status(404).end(); return; }
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="boreal-meeting.ics"');
  res.send(icsFor(room));
}));
router.get("/", ...staff, safeHandler(async (_req: any, res: any) => {
  const { rows } = await pool.query<MeetingRoom>(`SELECT id::text, code, slug, title, host_user_id::text, application_id, contact_id::text, starts_at, duration_min, status
       FROM meeting_rooms WHERE status <> 'cancelled' AND starts_at > now() - interval '1 day'
      ORDER BY starts_at ASC LIMIT 100`);
  res.json({ meetings: rows.map(view) });
}));
router.post("/", ...staff, safeHandler(async (req: any, res: any) => {
  const title = String(req.body?.title ?? "").trim();
  const startsAt = new Date(String(req.body?.startsAt ?? ""));
  if (!title) { res.status(400).json({ error: "title_required" }); return; }
  if (Number.isNaN(startsAt.getTime())) { res.status(400).json({ error: "start_time_required" }); return; }
  const room = await createRoom({ title, startsAt, durationMin: Number(req.body?.durationMin) || 60, hostUserId: req.user?.userId ?? null,
    applicationId: typeof req.body?.applicationId === "string" ? req.body.applicationId : null, contactId: typeof req.body?.contactId === "string" ? req.body.contactId : null });
  res.status(201).json({ meeting: view(room) });
}));
router.post("/:id/cancel", ...staff, safeHandler(async (req: any, res: any) => {
  const { rowCount } = await pool.query(`UPDATE meeting_rooms SET status = 'cancelled', updated_at = now() WHERE id::text = $1`, [String(req.params.id)]);
  res.status(rowCount ? 200 : 404).json({ ok: Boolean(rowCount) });
}));

export default router;
