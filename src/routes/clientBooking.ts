import { ALBERTA_TZ } from "../lib/albertaTime.js"; // BF_SERVER_ALBERTA_TIME_v743 - Alberta is UTC-6 all year
// BF_SERVER_CLIENT_BOOKING_v738 - public booking API used by the website and client app.
import { Router } from "express";
import { safeHandler } from "../middleware/safeHandler.js";
import { bookableStaff, openSlots, createBooking, bookingPhoneE164, BookingCalendarError } from "../services/clientBooking.js";
import { pool } from "../db.js";
import { parseExpressCaslConsent, recordExpressCaslConsent } from "../services/smsConsent.js"; // BF_SERVER_v789_CASL_EXPRESS_CONSENT

const router = Router();
const hits = new Map<string, number[]>();
function tooMany(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  recent.push(now); hits.set(ip, recent);
  return recent.length > 10;
}

// BF_SERVER_BOOKING_PER_STAFF_v739 - each advisor has their own booking link
// (boreal.financial/book-todd). The public API never lists the team; a page asks for one
// advisor by their link name (first name, lower case) and gets just that person.
export const slugOf = (firstName: string | null, email: string) => String(firstName || email.split(/[.@]/)[0] || "").toLowerCase().replace(/[^a-z0-9]/g, "");
router.get("/staff/:slug", safeHandler(async (req: any, res: any) => {
  const want = String(req.params.slug ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const s = (await bookableStaff()).find((x) => slugOf(x.first_name, x.email) === want);
  if (!s) { res.status(404).json({ error: "not_found" }); return; }
  res.json({ staff: { id: s.id, firstName: s.first_name || "your advisor", slug: want } });
}));

router.get("/slots", safeHandler(async (req: any, res: any) => {
  const staffId = typeof req.query?.staff === "string" && req.query.staff !== "any" ? req.query.staff : null;
  try {
    res.json({ timeZone: ALBERTA_TZ, slots: await openSlots(new Date(), staffId) });
  } catch (err) {
    console.error("[booking] slots failed", err instanceof Error ? err.message : String(err));
    res.status(503).json({ error: "calendar_unavailable", message: "Booking is temporarily unavailable. Please call (866) 631-8939." });
  }
}));

router.post("/", safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  if (b.website) { res.status(200).json({ ok: true }); return; }
  if (tooMany(String(req.ip ?? "unknown"))) { res.status(429).json({ error: "too_many_requests" }); return; }
  const kind = b.kind === "teams" ? "teams" : b.kind === "phone" ? "phone" : null;
  const name = String(b.name ?? "").trim().slice(0, 120);
  const email = String(b.email ?? "").trim().slice(0, 200);
  const phone = String(b.phone ?? "").trim().slice(0, 40) || null;
  const startsAt = new Date(String(b.startsAt ?? ""));
  if (!kind) { res.status(400).json({ error: "kind_must_be_phone_or_teams" }); return; }
  if (!name || !/^[^@ ]+@[^@ ]+[.][^@ ]+$/.test(email)) { res.status(400).json({ error: "name_and_email_required" }); return; }
  // BF_SERVER_v786_BOOKING_CRM - 10 digits, or 11 starting with 1; stored as E.164.
  const phoneE164 = phone ? bookingPhoneE164(phone) : null;
  if (kind === "phone" && !phoneE164) { res.status(400).json({ error: "invalid_phone" }); return; }
  if (Number.isNaN(startsAt.getTime())) { res.status(400).json({ error: "start_time_required" }); return; }
  // BF_SERVER_v789_CASL_EXPRESS_CONSENT - only an explicit casl_consent === true; recorded
  // once the booking has created or matched the contact (also when only Outlook failed).
  const consent = parseExpressCaslConsent(b);
  const recordConsent = () => recordExpressCaslConsent((sql, params) => pool.query(sql, params as any[]), { email, silo: "BF" }, consent, "website_booking");
  try {
    const out = await createBooking({ kind, startsAt, staffId: typeof b.staffId === "string" && b.staffId !== "any" ? b.staffId : null, name, email, phone: phoneE164, notes: String(b.notes ?? "").trim().slice(0, 1000) || null });
    if (!out.ok) { res.status(409).json({ error: out.reason, message: "That time was just taken. Please pick another." }); return; }
    await recordConsent();
    res.status(201).json(out);
  } catch (err) {
    if (err instanceof BookingCalendarError) await recordConsent();
    console.error("[booking] create failed", err instanceof Error ? err.message : String(err));
    res.status(503).json({ error: "booking_failed", message: "We couldn't book that right now. Please call (866) 631-8939." });
  }
}));

export default router;
