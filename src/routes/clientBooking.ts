// BF_SERVER_CLIENT_BOOKING_v738 - public booking API used by the website and client app.
import { Router } from "express";
import { safeHandler } from "../middleware/safeHandler.js";
import { bookableStaff, openSlots, createBooking } from "../services/clientBooking.js";

const router = Router();
const hits = new Map<string, number[]>();
function tooMany(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  recent.push(now); hits.set(ip, recent);
  return recent.length > 10;
}

router.get("/staff", safeHandler(async (_req: any, res: any) => {
  const staff = await bookableStaff();
  res.json({ staff: staff.map((s) => ({ id: s.id, firstName: s.first_name || "A Boreal advisor" })) });
}));

router.get("/slots", safeHandler(async (req: any, res: any) => {
  const staffId = typeof req.query?.staff === "string" && req.query.staff !== "any" ? req.query.staff : null;
  try {
    res.json({ timeZone: "America/Edmonton", slots: await openSlots(new Date(), staffId) });
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
  if (kind === "phone" && (!phone || phone.replace(/[^0-9]/g, "").length < 10)) { res.status(400).json({ error: "phone_required" }); return; }
  if (Number.isNaN(startsAt.getTime())) { res.status(400).json({ error: "start_time_required" }); return; }
  try {
    const out = await createBooking({ kind, startsAt, staffId: typeof b.staffId === "string" && b.staffId !== "any" ? b.staffId : null, name, email, phone, notes: String(b.notes ?? "").trim().slice(0, 1000) || null });
    if (!out.ok) { res.status(409).json({ error: out.reason, message: "That time was just taken. Please pick another." }); return; }
    res.status(201).json(out);
  } catch (err) {
    console.error("[booking] create failed", err instanceof Error ? err.message : String(err));
    res.status(503).json({ error: "booking_failed", message: "We couldn't book that right now. Please call (866) 631-8939." });
  }
}));

export default router;
