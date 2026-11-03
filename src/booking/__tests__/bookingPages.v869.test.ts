// BF_SERVER_v869_SETTINGS_PACK_BOOKING - public booking pages, meeting types, reminders and the client's manage link.
// The database fake answers by SQL content (not call order).
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), createBooking: vi.fn(), mail: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: h.query }, db: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("../../settingsPack/boreal.js", async (orig) => ({ ...(await orig<typeof import("../../settingsPack/boreal.js")>()), sendClientMail: h.mail }));
vi.mock("../../services/clientBooking.js", async (orig) => {
  const actual = await orig<typeof import("../../services/clientBooking.js")>();
  return {
    ...actual,
    bookableStaff: async () => [
      { id: "11111111-1111-4111-8111-111111111111", email: "jane@acme.test", first_name: "Jane", signed_in: true },
      { id: "22222222-2222-4222-8222-222222222222", email: "raj@acme.test", first_name: "Raj", signed_in: true },
    ],
    openSlots: async () => [{ startsAt: "2026-12-08T16:00:00.000Z", staffIds: ["11111111-1111-4111-8111-111111111111"] }],
    createBooking: h.createBooking,
  };
});

import {
  confirmationEmail, normalizeBookingSettings, reminderSms, sendDueReminders, validateMeetingType,
} from "../bookingPages.js";
import { candidateSlots, manageTokenHash, overlaps } from "../../services/clientBooking.js";

const JANE = "11111111-1111-4111-8111-111111111111";
const TYPE = { id: "33333333-3333-4333-8333-333333333333", slug: "intro", name: "Intro call", description: null, duration_min: 45, kind: "video", buffer_min: 15, min_notice_min: 240, max_days_ahead: 30, active: true, sort: 0 };

describe("slots and meeting types", () => {
  it("offers slots that fit the meeting length inside the booking hours (Alberta time), with notice", () => {
    const now = new Date("2026-12-07T14:00:00Z"); // Monday 08:00 Alberta
    const hours = { 0: [], 1: [["09:00", "11:00"]], 2: [], 3: [], 4: [], 5: [], 6: [] } as any;
    const slots = candidateSlots(now, 0, { durationMin: 60, minNoticeMin: 90, hours });
    // 09:00 is within 90 minutes' notice; 09:30, 10:00 fit; 10:30 would end after 11:00.
    expect(slots.map((d) => d.toISOString())).toEqual(["2026-12-07T15:30:00.000Z", "2026-12-07T16:00:00.000Z"]);
  });

  it("keeps the buffer free around other meetings", () => {
    const busy = [{ start: new Date("2026-12-07T16:00:00Z"), end: new Date("2026-12-07T16:30:00Z") }];
    expect(overlaps(new Date("2026-12-07T16:30:00Z"), busy, 30, 0)).toBe(false);
    expect(overlaps(new Date("2026-12-07T16:30:00Z"), busy, 30, 15)).toBe(true);
    expect(overlaps(new Date("2026-12-07T15:20:00Z"), busy, 30, 15)).toBe(true);
    expect(overlaps(new Date("2026-12-07T15:15:00Z"), busy, 30, 15)).toBe(false);
  });

  it("validates a meeting type", () => {
    expect(validateMeetingType({ name: "Intro call", duration_min: 45, kind: "video" })).toMatchObject({ ok: true, value: { slug: "intro-call", duration_min: 45, kind: "video", min_notice_min: 120, max_days_ahead: 14 } });
    const bad = validateMeetingType({ name: "", duration_min: 500, buffer_min: -1, max_days_ahead: 0 });
    expect(bad.ok).toBe(false);
    expect(Object.keys((bad as any).errors).sort()).toEqual(["buffer_min", "duration_min", "max_days_ahead", "name", "slug"]);
  });

  it("normalises booking settings, defaulting to weekday 09:00-17:00 and every reminder on", () => {
    const s = normalizeBookingSettings({ hours: { 1: [["10:00", "12:00"], ["bad", "x"]] }, reminders: { sms_1h: false } });
    expect(s.hours[1]).toEqual([["10:00", "12:00"]]);
    expect(s.hours[2]).toEqual([["09:00", "17:00"]]);
    expect(s.hours[0]).toEqual([]);
    expect(s.reminders).toEqual({ email_24h: true, email_1h: true, sms_24h: true, sms_1h: false });
  });
});

describe("messages", () => {
  const msg = { clientName: "Pat", startsAt: "2026-12-08T16:00:00.000Z", durationMin: 45, kind: "teams" as const, staffFirstName: "Jane", meetingName: "Intro call", joinUrl: "https://meet.example/x", phone: null, manageToken: "tok_abcdefghijklmnopqrstuvwxyz" };
  it("the confirmation gives the time in Alberta time, how to join and the change link", () => {
    const m = confirmationEmail(msg);
    expect(m.text).toContain("Tuesday, December 8");
    expect(m.text).toContain("10:00");
    expect(m.text).toContain("(Alberta time)");
    expect(m.text).toContain("https://meet.example/x");
    expect(m.text).toContain("/book/manage/tok_abcdefghijklmnopqrstuvwxyz");
    expect(m.text).not.toMatch(/587.?888.?1837/);
  });
  it("a text reminder offers STOP", () => {
    expect(reminderSms({ ...msg, manageToken: null }, "1h")).toMatch(/in about an hour.*Reply STOP to opt out\.$/);
  });
});

describe("reminders", () => {
  let claimed: string[];
  function remindersDb(row: Record<string, unknown>, settings: unknown = null) {
    claimed = [];
    h.query.mockImplementation(answerBySql([
      [/FROM boreal_settings WHERE key = \$1/, { rows: settings ? [{ value: settings }] : [] }],
      [/UPDATE client_bookings b SET reminder_24h_at/, () => { claimed.push("24h"); return { rows: [{ id: "b1" }] }; }],
      [/UPDATE client_bookings b SET reminder_1h_at/, () => { claimed.push("1h"); return { rows: [] }; }],
      [/FROM client_bookings b\s+LEFT JOIN users u/, { rows: [{ id: "b1", contact_id: "c1", kind: "phone", starts_at: "2026-12-08T16:00:00Z", duration_min: 30, client_name: "Pat", client_email: "pat@x.test", client_phone: "+14035550100", join_url: null, staff_first_name: "Jane", meeting_name: null, ...row }] }],
    ]));
  }
  const deps = () => ({ email: vi.fn(async () => ({ ok: true })), sms: vi.fn(async () => ({ ok: true })), now: () => new Date("2026-12-07T17:00:00Z") });

  it("sends the email, and a text only with the client's tick and texting consent, then logs it", async () => {
    remindersDb({ sms_reminders: true, sms_consent: true, opted_out: false });
    const d = deps();
    expect(await sendDueReminders({ query: h.query } as any, d)).toEqual({ email: 1, sms: 1, errors: 0 });
    expect(d.email).toHaveBeenCalledWith("pat@x.test", expect.stringContaining("Reminder"), expect.any(String), expect.any(String));
    expect(d.sms.mock.calls[0]![0]).toBe("+14035550100");
    expect(claimed).toEqual(["24h", "1h"]);
    const [, params] = callsMatching(h.query, /INSERT INTO crm_timeline_events/)[0]!;
    expect(params![1]).toBe("booking_reminder_sent");
  });

  it("never texts without consent, after STOP, or when the client did not ask", async () => {
    for (const row of [{ sms_reminders: true, sms_consent: null, opted_out: false }, { sms_reminders: true, sms_consent: true, opted_out: true }, { sms_reminders: false, sms_consent: true, opted_out: false }]) {
      remindersDb(row);
      const d = deps();
      const r = await sendDueReminders({ query: h.query } as any, d);
      expect(r.sms).toBe(0);
      expect(d.sms).not.toHaveBeenCalled();
      expect(r.email).toBe(1);
    }
  });

  it("an old saved Booking pages setting no longer switches reminders off (BF_SERVER_v885_BOOKING_ORIGINAL)", async () => {
    remindersDb({ sms_reminders: true, sms_consent: true }, { reminders: { email_24h: false, email_1h: false, sms_24h: false, sms_1h: false } });
    const d = deps();
    expect((await sendDueReminders({ query: h.query } as any, d)).email).toBe(1);
  });
});

// ------------------------------------------------------------------ the public pages
const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";
let bookingRow: Record<string, unknown> | null;
function publicDb(extra: SqlRule[] = []) {
  h.query.mockImplementation(answerBySql([
    ...extra,
    [/FROM boreal_settings WHERE key = \$1/, { rows: [] }],
    [/FROM booking_meeting_types WHERE active/, { rows: [TYPE] }],
    [/FROM client_bookings b\s+LEFT JOIN users u ON u\.id = b\.staff_user_id\s+LEFT JOIN booking_meeting_types mt ON mt\.id = b\.meeting_type_id\s+WHERE b\.manage_token_hash = \$1/, (_s: string, p?: unknown[]) => ({ rows: bookingRow && p?.[0] === manageTokenHash(TOKEN) ? [bookingRow] : [] })],
  ]));
}
async function pub() {
  const router = (await import("../../routes/clientBooking.js")).default;
  const a = express();
  a.set("trust proxy", true);
  a.use(express.json());
  a.use("/api/booking", router);
  return a;
}
let ipN = 1;
const ip = () => `10.9.0.${ipN++}`;

describe("public booking pages", () => {
  beforeEach(() => {
    h.query.mockReset(); h.createBooking.mockReset(); h.mail.mockReset(); h.mail.mockResolvedValue({ ok: true });
    bookingRow = null;
    publicDb();
    h.createBooking.mockResolvedValue({ ok: true, booking: { id: "b-new", startsAt: "2026-12-08T16:00:00.000Z", staffFirstName: "Jane", kind: "teams", joinUrl: "https://meet.example/x", manageToken: TOKEN, contactId: "c1", contactCreated: true, durationMin: 45 } });
  });

  it("the client-app booking page is retired; the website's advisor lookup still works", async () => {
    const a = await pub();
    expect((await request(a).get("/api/booking/page/jane")).status).toBe(404);
  });

  it("booking creates the original call, logs it on the contact's timeline and emails the change link", async () => {
    const res = await request(await pub()).post("/api/booking").set("X-Forwarded-For", ip())
      .send({ kind: "teams", name: "Pat Lee", email: "pat@x.test", phone: "403-555-0100", startsAt: "2026-12-08T16:00:00.000Z", sms_reminders: true });
    expect(res.status).toBe(201);
    const input = h.createBooking.mock.calls[0]![0];
    expect(input).toMatchObject({ kind: "teams", meetingType: { duration_min: 30 }, smsReminders: false }); // no CASL consent, no texts
    const [, tl] = callsMatching(h.query, /INSERT INTO crm_timeline_events/)[0]!;
    expect(tl).toEqual(["c1", "booking_made", expect.stringContaining('"booking_id":"b-new"')]);
    await vi.waitFor(() => expect(h.mail).toHaveBeenCalled());
    expect(h.mail.mock.calls[0]![0].text).toContain(`/book/manage/${TOKEN}`);
  });

  it("text reminders need the client's express consent", async () => {
    await request(await pub()).post("/api/booking").set("X-Forwarded-For", ip())
      .send({ kind: "phone", name: "Pat Lee", email: "pat@x.test", phone: "403-555-0100", startsAt: "2026-12-08T16:00:00.000Z", sms_reminders: true,
        casl_consent: true, casl_consent_text: "Yes, text me reminders.", casl_consent_at: new Date().toISOString() });
    expect(h.createBooking.mock.calls[0]![0].smsReminders).toBe(true);
  });

  it("the client can see, cancel and reschedule with their link", async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    bookingRow = { id: "b-old", contact_id: "c1", staff_user_id: JANE, staff_email: "jane@acme.test", kind: "teams", starts_at: future, duration_min: 45, client_name: "Pat", client_email: "pat@x.test", client_phone: null, status: "booked", join_url: null, graph_event_id: null, google_event_id: null, crm_meeting_id: "m1", meeting_type_id: TYPE.id, sms_reminders: false, staff_first_name: "Jane", meeting_name: "Intro call" };
    const a = await pub();
    const view = await request(a).get(`/api/booking/manage/${TOKEN}`);
    expect(view.body.booking).toMatchObject({ status: "booked", meetingName: "Intro call", canChange: true });
    expect((await request(a).get("/api/booking/manage/wrongtokenwrongtokenwrongtoken")).status).toBe(404);

    const moved = await request(a).post(`/api/booking/manage/${TOKEN}/reschedule`).send({ startsAt: "2026-12-08T16:00:00.000Z" });
    expect(moved.status).toBe(201);
    expect(h.createBooking.mock.calls[0]![0]).toMatchObject({ staffId: JANE, name: "Pat", email: "pat@x.test" });
    expect(callsMatching(h.query, /UPDATE client_bookings SET status = \$2/)[0]![1]).toEqual(["b-old", "rescheduled", "b-new"]);

    const cancel = await request(a).post(`/api/booking/manage/${TOKEN}/cancel`);
    expect(cancel.body).toEqual({ ok: true, status: "cancelled" });
    expect(callsMatching(h.query, /UPDATE crm_meetings SET status = 'cancelled'/).length).toBeGreaterThan(0);
    expect(callsMatching(h.query, /INSERT INTO crm_timeline_events/).map((c) => (c[1] as unknown[])[1])).toContain("booking_cancelled");
  });
});

// BF_SERVER_v885_BOOKING_ORIGINAL - Settings > Booking pages (meeting types, my link) retired.
