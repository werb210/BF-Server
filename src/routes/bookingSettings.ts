// BF_SERVER_v869_SETTINGS_PACK_BOOKING - Settings > Booking pages.
//   GET    /api/booking-settings                     Admin: settings, meeting types and everyone's booking link
//   PUT    /api/booking-settings { settings }        Admin: team page on/off, booking hours, reminders, confirmation note
//   POST   /api/booking-settings/meeting-types       Admin: add a meeting type
//   PUT    /api/booking-settings/meeting-types/:id   Admin: edit one
//   DELETE /api/booking-settings/meeting-types/:id   Admin: remove one
//   GET    /api/booking-settings/my-link             Admin/Staff: their own page and the team page (staff profile)
// Every change is audited.
import { Router } from "express";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { actorId, auditFor, UUID_RE, type Q } from "../settingsPack/common.js";
import { brokerageZoneName, zoneLabel } from "../settingsPack/boreal.js";
import {
  bookingLinks, bookingSettings, createMeetingType, deleteMeetingType, listMeetingTypes, saveBookingSettings, updateMeetingType,
  validateMeetingType,
} from "../booking/bookingPages.js";

const router = Router();
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];
const db = (): Q => pool as unknown as Q;

router.get("/", ...adminOnly, safeHandler(async (_req: any, res: any) => {
  const [settings, types, links] = await Promise.all([bookingSettings(db()), listMeetingTypes(db()), bookingLinks()]);
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, settings, meeting_types: types, links, time_zone: brokerageZoneName(), zone_label: zoneLabel() });
}));

router.put("/", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const settings = await saveBookingSettings(db(), req.body?.settings, actorId(req));
  await auditFor(req, "booking_settings.updated", { team_page: settings.team_page, reminders: settings.reminders }, { type: "booking_settings", id: "booking" });
  return res.json({ ok: true, settings });
}));

router.post("/meeting-types", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const v = validateMeetingType(req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: "validation_error", errors: v.errors });
  const row = await createMeetingType(db(), v.value);
  if (!row) return res.status(409).json({ ok: false, error: "slug_taken", errors: { slug: "Another meeting type already uses that link name." } });
  await auditFor(req, "booking_meeting_type.created", { name: row.name, duration_min: row.duration_min, kind: row.kind }, { type: "booking_meeting_type", id: row.id });
  return res.status(201).json({ ok: true, meeting_type: row });
}));

router.put("/meeting-types/:id", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
  const v = validateMeetingType(req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: "validation_error", errors: v.errors });
  try {
    const row = await updateMeetingType(db(), id, v.value);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });
    await auditFor(req, "booking_meeting_type.updated", { name: row.name, duration_min: row.duration_min, kind: row.kind, active: row.active }, { type: "booking_meeting_type", id });
    return res.json({ ok: true, meeting_type: row });
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "slug_taken", errors: { slug: "Another meeting type already uses that link name." } });
    throw err;
  }
}));

router.delete("/meeting-types/:id", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id) || !(await deleteMeetingType(db(), id))) return res.status(404).json({ ok: false, error: "not_found" });
  await auditFor(req, "booking_meeting_type.deleted", {}, { type: "booking_meeting_type", id });
  return res.json({ ok: true });
}));

router.get("/my-link", ...staff, safeHandler(async (req: any, res: any) => {
  const links = await bookingLinks();
  const mine = links.staff.find((s) => s.user_id === actorId(req)) ?? null;
  const settings = await bookingSettings(db());
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, mine, team: settings.team_page ? links.team : null });
}));

export default router;
