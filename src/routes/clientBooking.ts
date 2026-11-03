import { brokerageTimeZone, zoneLabel } from "../settingsPack/boreal.js"; // BF_SERVER_v869_BOOKING_PAGES - Alberta time, UTC-6 all year
// BF_SERVER_CLIENT_BOOKING_v738 - public booking API used by the client app's booking pages.
// BF_SERVER_v869_SETTINGS_PACK_BOOKING - public booking pages: GET /page/:slug (a staff member's page, or "team" for round
// robin) with the meeting types; slots per meeting type; the confirmation email with the client's own manage link;
// GET/POST /manage/:token to cancel or reschedule.
import { Router } from "express";
import { safeHandler } from "../middleware/safeHandler.js";
import { openSlots, createBooking, bookingPhoneE164, BookingCalendarError, manageTokenHash, type MeetingType } from "../services/clientBooking.js";
import { pool } from "../db.js";
import { parseExpressCaslConsent, recordExpressCaslConsent } from "../services/smsConsent.js"; // BF_SERVER_v789_CASL_EXPRESS_CONSENT
import { brandName, supportPhone } from "../settingsPack/boreal.js";
import {
  bookingByToken, bookingSettings, cancelledEmail, confirmationEmail, findOfferedType, logBookingTimeline, markCancelled,
  removeCalendarEvent, slugOf, staffForSlug, type BookingMessageInput,
} from "../booking/bookingPages.js";
import type { Q } from "../settingsPack/common.js";

const router = Router();
const db = (): Q => pool as unknown as Q;
const hits = new Map<string, number[]>();
function tooMany(ip: string, limit = 10): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  recent.push(now); hits.set(ip, recent);
  return recent.length > limit;
}
// BF_SERVER_v869_BOOKING_PAGES - the 866 main line in failure messages.
const callUs = () => (supportPhone() ? ` Please call ${supportPhone()}.` : " Please try again shortly.");

export { slugOf };

const publicType = (t: MeetingType) => ({ id: t.id, slug: t.slug, name: t.name, description: t.description, duration_min: t.duration_min, kind: t.kind, min_notice_min: t.min_notice_min, max_days_ahead: t.max_days_ahead });

// BF_SERVER_BOOKING_PER_STAFF_v739 - the public API never lists the team; a page asks for one advisor by link name.
router.get("/staff/:slug", safeHandler(async (req: any, res: any) => {
  const s = await staffForSlug(String(req.params.slug ?? ""));
  if (!s) { res.status(404).json({ error: "not_found" }); return; }
  res.json({ staff: { id: s.id, firstName: s.first_name || "your advisor", slug: slugOf(s.first_name, s.email) } });
}));

// BF_SERVER_v885_BOOKING_ORIGINAL - GET /page/:slug (the client-app booking page) is retired; the website page uses /staff/:slug.

router.get("/slots", safeHandler(async (req: any, res: any) => {
  const staffId = typeof req.query?.staff === "string" && req.query.staff !== "any" ? req.query.staff : null;
  const type = await findOfferedType(db(), req.query?.type);
  if (!type) { res.status(404).json({ error: "meeting_type_not_found" }); return; }
  try {
    const settings = await bookingSettings(db());
    res.json({ timeZone: brokerageTimeZone(), zoneLabel: zoneLabel(), meetingType: publicType(type), slots: await openSlots(new Date(), staffId, undefined, type, settings.hours) });
  } catch (err) {
    console.error("[booking] slots failed", err instanceof Error ? err.message : String(err));
    res.status(503).json({ error: "calendar_unavailable", message: "Booking is temporarily unavailable." + callUs() });
  }
}));

async function sendConfirmation(to: string, msg: BookingMessageInput, bookingId: string): Promise<void> {
  try {
    const { sendClientMail: sendPlanMail } = await import("../settingsPack/boreal.js");
    const m = confirmationEmail(msg);
    const r = await sendPlanMail({ to: [to], subject: m.subject, html: m.html, text: m.text });
    if (r.ok) await pool.query(`UPDATE client_bookings SET confirmation_sent_at = now() WHERE id::text = $1`, [bookingId]);
    else console.warn("[booking] confirmation email not sent", { bookingId, error: r.error });
  } catch (err) {
    console.warn("[booking] confirmation email failed", { bookingId, message: err instanceof Error ? err.message : String(err) });
  }
}

type BookBody = { kind?: unknown; name?: unknown; email?: unknown; phone?: unknown; startsAt?: unknown; staffId?: unknown; notes?: unknown; meetingTypeId?: unknown; sms_reminders?: unknown; website?: unknown };

async function book(req: any, res: any, b: BookBody, opts: { staffId?: string | null; source: string; previous?: { id: string; contactId: string | null }; smsReminders?: boolean } = { source: "website_booking" }) {
  const type = await findOfferedType(db(), b.meetingTypeId);
  if (!type) { res.status(404).json({ error: "meeting_type_not_found" }); return null; }
  // A meeting type sets phone or video; without types the client still chooses (the original booking form).
  const kind = type.id ? (type.kind === "video" ? "teams" : "phone") : (b.kind === "teams" ? "teams" : b.kind === "phone" ? "phone" : null);
  const name = String(b.name ?? "").trim().slice(0, 120);
  const email = String(b.email ?? "").trim().slice(0, 200);
  const phone = String(b.phone ?? "").trim().slice(0, 40) || null;
  const startsAt = new Date(String(b.startsAt ?? ""));
  if (!kind) { res.status(400).json({ error: "kind_must_be_phone_or_teams" }); return null; }
  if (!name || !/^[^@ ]+@[^@ ]+[.][^@ ]+$/.test(email)) { res.status(400).json({ error: "name_and_email_required" }); return null; }
  const phoneE164 = phone ? bookingPhoneE164(phone) : null;
  if (kind === "phone" && !phoneE164) { res.status(400).json({ error: "invalid_phone" }); return null; }
  if (phone && !phoneE164) { res.status(400).json({ error: "invalid_phone" }); return null; }
  if (Number.isNaN(startsAt.getTime())) { res.status(400).json({ error: "start_time_required" }); return null; }
  // BF_SERVER_v789_CASL_EXPRESS_CONSENT - only an explicit casl_consent === true; recorded once the booking has
  // created or matched the contact (also when only the calendar failed). Text reminders need it too.
  const consent = parseExpressCaslConsent(b);
  const recordConsent = () => recordExpressCaslConsent((sql, params) => pool.query(sql, params as any[]), { email, silo: "BF" }, consent, opts.source);
  const settings = await bookingSettings(db());
  const staffId = opts.staffId !== undefined ? opts.staffId : (typeof b.staffId === "string" && b.staffId !== "any" ? b.staffId : null);
  try {
    const out = await createBooking({
      kind, startsAt, staffId, name, email, phone: phoneE164, notes: String(b.notes ?? "").trim().slice(0, 1000) || null,
      meetingType: type, hours: settings.hours, smsReminders: opts.smsReminders ?? (b.sms_reminders === true && consent !== null),
    });
    if (!out.ok) { res.status(409).json({ error: out.reason, message: "That time was just taken. Please pick another." }); return null; }
    await recordConsent();
    const msg: BookingMessageInput = {
      clientName: name, startsAt: out.booking.startsAt, durationMin: type.duration_min, kind, staffFirstName: out.booking.staffFirstName,
      meetingName: type.name, joinUrl: out.booking.joinUrl, phone: phoneE164, manageToken: out.booking.manageToken ?? null, note: settings.confirmation_note,
    };
    await logBookingTimeline(db(), out.booking.contactId ?? null, opts.previous ? "booking_rescheduled" : "booking_made", {
      booking_id: out.booking.id, starts_at: out.booking.startsAt, meeting_type: type.name, kind, source: opts.source, ...(opts.previous ? { previous_booking_id: opts.previous.id } : {}),
    });
    void sendConfirmation(email, msg, out.booking.id);
    return out;
  } catch (err) {
    if (err instanceof BookingCalendarError) await recordConsent();
    console.error("[booking] create failed", err instanceof Error ? err.message : String(err));
    res.status(503).json({ error: "booking_failed", message: "We couldn't book that right now." + callUs() });
    return null;
  }
}

router.post("/", safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  if (b.website) { res.status(200).json({ ok: true }); return; }
  if (tooMany(String(req.ip ?? "unknown"))) { res.status(429).json({ error: "too_many_requests" }); return; }
  const out = await book(req, res, b);
  if (out) res.status(201).json(out);
}));

// ------------------------------------------------------------------ the client's own manage link
const TOKEN_RE = /^[A-Za-z0-9_-]{20,80}$/;
async function managed(req: any, res: any) {
  const token = String(req.params.token ?? "");
  if (!TOKEN_RE.test(token)) { res.status(404).json({ error: "not_found" }); return null; }
  if (tooMany(`manage:${req.ip ?? "unknown"}`, 60)) { res.status(429).json({ error: "too_many_requests" }); return null; }
  const b = await bookingByToken(db(), manageTokenHash(token));
  if (!b) { res.status(404).json({ error: "not_found" }); return null; }
  return b;
}

router.get("/manage/:token", safeHandler(async (req: any, res: any) => {
  const b = await managed(req, res);
  if (!b) return;
  const type = b.meeting_type_id ? await findOfferedType(db(), b.meeting_type_id) : null;
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true, company: brandName(), zoneLabel: zoneLabel(), timeZone: brokerageTimeZone(),
    booking: {
      status: b.status, startsAt: new Date(b.starts_at).toISOString(), durationMin: Number(b.duration_min), kind: b.kind,
      staffFirstName: b.staff_first_name, meetingName: b.meeting_name || (b.kind === "phone" ? "Phone call" : "Video meeting"),
      meetingTypeId: type?.id ?? null, staffId: b.staff_user_id, joinUrl: b.join_url,
      canChange: b.status === "booked" && new Date(b.starts_at).getTime() > Date.now(),
    },
  });
}));

router.post("/manage/:token/cancel", safeHandler(async (req: any, res: any) => {
  const b = await managed(req, res);
  if (!b) return;
  if (b.status !== "booked" || new Date(b.starts_at).getTime() <= Date.now()) { res.status(409).json({ error: "not_changeable", message: "This booking can no longer be changed." }); return; }
  await markCancelled(db(), b, "client_cancelled");
  const calendar = await removeCalendarEvent(b);
  await logBookingTimeline(db(), b.contact_id, "booking_cancelled", { booking_id: b.id, starts_at: new Date(b.starts_at).toISOString(), by: "client", calendar_updated: calendar });
  if (b.client_email) {
    try {
      const { sendClientMail: sendPlanMail } = await import("../settingsPack/boreal.js");
      const m = cancelledEmail({ clientName: b.client_name, startsAt: new Date(b.starts_at).toISOString(), durationMin: Number(b.duration_min), kind: b.kind, staffFirstName: b.staff_first_name, meetingName: b.meeting_name || "Meeting", joinUrl: null, phone: null, manageToken: null });
      const r = await sendPlanMail({ to: [b.client_email], subject: m.subject, html: m.html, text: m.text });
      if (!r.ok) console.warn("[booking] cancellation email not sent", { bookingId: b.id, error: r.error });
    } catch (err) {
      console.warn("[booking] cancellation email failed", { bookingId: b.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  res.json({ ok: true, status: "cancelled" });
}));

// Reschedule = a new booking with the same person (same meeting type and details), then the old one is cancelled.
router.post("/manage/:token/reschedule", safeHandler(async (req: any, res: any) => {
  const b = await managed(req, res);
  if (!b) return;
  if (b.status !== "booked" || new Date(b.starts_at).getTime() <= Date.now()) { res.status(409).json({ error: "not_changeable", message: "This booking can no longer be changed." }); return; }
  const body: BookBody = {
    kind: b.kind, name: b.client_name, email: b.client_email ?? "", phone: b.client_phone ?? "", startsAt: req.body?.startsAt,
    meetingTypeId: b.meeting_type_id ?? undefined, sms_reminders: b.sms_reminders, notes: null,
  };
  // The client's earlier choice about text reminders carries over (their consent is already on the contact).
  const out = await book(req, res, body, { staffId: b.staff_user_id, source: "booking_reschedule", previous: { id: b.id, contactId: b.contact_id }, smsReminders: b.sms_reminders });
  if (!out || !out.ok) return;
  await markCancelled(db(), b, "rescheduled", out.booking.id);
  await removeCalendarEvent(b);
  res.status(201).json(out);
}));

export default router;
