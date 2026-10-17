// BF_SERVER_v821_DIALER - do-not-disturb by hours: validation, the per-user time zone (DST via Intl), the
// GET/PUT /api/staff/call-hours routes and the TwiML for direct lines, named reception targets and the group ring.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { mountRouter, staffToken, STAFF_USER_ID } from "./helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query, runQuery: h.query }));
vi.mock("../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});
vi.mock("../modules/calls/calls.service.js", async () => ({
  ...(await vi.importActual<any>("../modules/calls/calls.service.js")),
  startCall: async () => ({ id: "call-1" }),
}));

import { defaultWeekly, isWithinCallHours, localDayAndMinutes, validateCallHoursInput } from "../voice/callHours.js";

const OWNER = "44444444-4444-4444-8444-444444444444";
const ANDREW = "22222222-2222-4222-8222-222222222222";
const CALLER = "+14035550142";
const HOURS_SQL = /FROM staff_call_hours WHERE user_id::text = \$1/;
const GROUP_HOURS_SQL = /FROM staff_call_hours h JOIN staff_presence sp/;
const EDMONTON = "America/Edmonton";
const workdays = { enabled: true, timezone: EDMONTON, weekly: defaultWeekly() }; // Mon-Fri 08:00-18:00
const awayRow = (row: Record<string, unknown> = {}) => ({ user_id: OWNER, enabled: true, timezone: EDMONTON, weekly: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }, urgent_passthrough: true, updated_at: "2026-10-17T00:00:00Z", ...row });

beforeEach(() => { h.query.mockReset(); h.query.mockImplementation(answerBySql([])); vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe("call hours: time zone and DST (Intl)", () => {
  it("the same UTC instant is inside hours in summer (MDT, UTC-6) and outside in winter (MST, UTC-7)", () => {
    // Wednesdays, 14:30 UTC: 08:30 MDT in July, 07:30 MST in January.
    expect(localDayAndMinutes(new Date("2026-07-15T14:30:00Z"), EDMONTON)).toEqual({ day: "wed", minutes: 8 * 60 + 30 });
    expect(localDayAndMinutes(new Date("2026-01-14T14:30:00Z"), EDMONTON)).toEqual({ day: "wed", minutes: 7 * 60 + 30 });
    expect(isWithinCallHours(workdays, new Date("2026-07-15T14:30:00Z"))).toBe(true);
    expect(isWithinCallHours(workdays, new Date("2026-01-14T14:30:00Z"))).toBe(false);
  });

  it("follows the spring-forward and fall-back days", () => {
    // Use historical transitions: tzdata 2026c keeps Edmonton on MDT after March 2026.
    // 2025-03-10 (Mon): 08:05 MDT = 14:05 UTC. 2025-11-03 (Mon): 08:05 MST = 15:05 UTC.
    expect(isWithinCallHours(workdays, new Date("2025-03-10T14:05:00Z"))).toBe(true);
    expect(isWithinCallHours(workdays, new Date("2025-11-03T14:05:00Z"))).toBe(false);
    expect(isWithinCallHours(workdays, new Date("2025-11-03T15:05:00Z"))).toBe(true);
  });

  it("uses the person's own zone (not presenceService's America/Regina), the local weekday, and [start, end)", () => {
    const toronto = { ...workdays, timezone: "America/Toronto" };
    expect(isWithinCallHours(toronto, new Date("2026-07-15T12:30:00Z"))).toBe(true); // 08:30 EDT
    expect(isWithinCallHours(workdays, new Date("2026-07-15T12:30:00Z"))).toBe(false); // 06:30 MDT
    expect(isWithinCallHours(workdays, new Date("2026-07-16T00:00:00Z"))).toBe(false); // 18:00 MDT Wed: end is exclusive
    expect(isWithinCallHours(workdays, new Date("2026-07-18T16:00:00Z"))).toBe(false); // Saturday
    expect(isWithinCallHours({ ...workdays, enabled: false }, new Date("2026-07-18T16:00:00Z"))).toBe(true); // off = always reachable
  });
});

describe("validateCallHoursInput", () => {
  const ok = { enabled: true, timezone: EDMONTON, weekly: { mon: [["08:00", "12:00"], ["13:00", "18:00"]], sat: [] }, urgentPassthrough: false };

  it("accepts HH:MM ranges, fills missing days with [], keeps urgentPassthrough", () => {
    const r = validateCallHoursInput(ok);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ enabled: true, timezone: EDMONTON, urgentPassthrough: false,
      weekly: { sun: [], mon: [["08:00", "12:00"], ["13:00", "18:00"]], tue: [], wed: [], thu: [], fri: [], sat: [] } });
  });

  it.each([
    [{ ...ok, enabled: "yes" }, "invalid_enabled"],
    [{ ...ok, timezone: "Mars/Olympus" }, "invalid_timezone"],
    [{ ...ok, weekly: { mon: [["8:00", "12:00"]] } }, "invalid_time"],
    [{ ...ok, weekly: { mon: [["24:00", "25:00"]] } }, "invalid_time"],
    [{ ...ok, weekly: { mon: [["12:00", "08:00"]] } }, "invalid_range"],
    [{ ...ok, weekly: { mon: [["01:00", "02:00"], ["03:00", "04:00"], ["05:00", "06:00"], ["07:00", "08:00"]] } }, "too_many_ranges"],
    [{ ...ok, weekly: { funday: [] } }, "invalid_weekly"],
    [{ ...ok, weekly: [] }, "invalid_weekly"],
    [{ ...ok, urgentPassthrough: "no" }, "invalid_urgent_passthrough"],
  ])("rejects %j as %s", (body, code) => {
    const r = validateCallHoursInput(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(code);
  });
});

describe("GET/PUT /api/staff/call-hours", () => {
  const app = async () => mountRouter((await import("../routes/staffDialer.js")).callHoursRouter, "/api/staff/call-hours");
  const auth = () => ({ Authorization: `Bearer ${staffToken("Staff")}` });

  it("GET returns the defaults (off, America/Edmonton, Mon-Fri 08-18, passthrough on) when nothing is saved", async () => {
    const res = await request(await app()).get("/api/staff/call-hours").set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, timezone: EDMONTON, weekly: defaultWeekly(), urgentPassthrough: true, updatedAt: null });
    expect(callsMatching(h.query, HOURS_SQL)[0]![1]).toEqual([STAFF_USER_ID]);
  });

  it("PUT validates and upserts the signed-in user's settings", async () => {
    h.query.mockImplementation(answerBySql([[/INSERT INTO staff_call_hours/, (_s: string, p?: unknown[]) => ({ rows: [{
      user_id: p![0], enabled: p![1], timezone: p![2], weekly: JSON.parse(String(p![3])), urgent_passthrough: p![4], updated_at: "2026-10-17T18:00:00Z",
    }] })]]));
    const body = { enabled: true, timezone: "America/Vancouver", weekly: { mon: [["09:00", "17:00"]] }, urgentPassthrough: false };
    const res = await request(await app()).put("/api/staff/call-hours").set(auth()).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, timezone: "America/Vancouver", urgentPassthrough: false, updatedAt: "2026-10-17T18:00:00.000Z" });
    expect(res.body.weekly.mon).toEqual([["09:00", "17:00"]]);
    const [, params] = callsMatching(h.query, /INSERT INTO staff_call_hours/)[0]!;
    expect((params as unknown[])[0]).toBe(STAFF_USER_ID);
    expect((await request(await app()).put("/api/staff/call-hours").set(auth()).send({ ...body, timezone: "nope" })).status).toBe(400);
    expect((await request(await app()).put("/api/staff/call-hours").send(body)).status).toBe(401);
  });
});

describe("TwiML outside call hours", () => {
  async function directLine(row: Record<string, unknown> | null) {
    h.query.mockImplementation(answerBySql([
      [/WHERE u\.direct_number = \$1/, { rows: [{ user_id: OWNER, first_name: "Pat", last_name: "Staff", twilio_identity: OWNER }] }],
      [HOURS_SQL, { rows: row ? [row] : [] }],
    ]));
    const app = mountRouter((await import("../routes/webhooks.js")).default, "/api/webhooks");
    const res = await request(app).post("/api/webhooks/twilio/voice/twiml").type("form").send({ From: CALLER, To: "+18255550190", CallSid: "CA-dnd-1" });
    expect(res.status).toBe(200);
    return res.text;
  }

  it("direct line, passthrough on: away prompt in a 1-digit 6 s Gather, then their voicemail", async () => {
    const xml = await directLine(awayRow());
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response>'
      + `<Gather input="dtmf" numDigits="1" timeout="6" action="/api/webhooks/twilio/reception/away-choice?user=${OWNER}&amp;ring=direct" method="POST">`
      + '<Say voice="Polly.Joanna">Pat is away right now. To leave a voicemail, stay on the line. If this is urgent, press 1.</Say></Gather>'
      + '<Say voice="Polly.Joanna">Please leave your name, number, and a brief message after the tone.</Say>'
      + `<Record maxLength="120" playBeep="true" action="/api/webhooks/twilio/voicemail?staff=${OWNER}"/></Response>`);
  });

  it("direct line, passthrough off: straight to voicemail", async () => {
    const xml = await directLine(awayRow({ urgent_passthrough: false }));
    expect(xml).not.toContain("<Gather");
    expect(xml).not.toContain("<Dial");
    expect(xml).toContain("Pat is away right now.");
    expect(xml).toContain(`/api/webhooks/twilio/voicemail?staff=${OWNER}`);
  });

  it("direct line within hours (or DND off) rings as normal", async () => {
    expect(await directLine(awayRow({ enabled: false }))).toContain(`<Client>${OWNER}</Client>`);
    expect(await directLine(null)).toContain(`<Client>${OWNER}</Client>`);
  });

  async function awayChoice(query: string, body: Record<string, string>, rules: Array<[RegExp, unknown]> = []) {
    h.query.mockImplementation(answerBySql(rules));
    const app = mountRouter((await import("../routes/reception.js")).default, "/api/webhooks/twilio/reception");
    const res = await request(app).post(`/api/webhooks/twilio/reception/away-choice?${query}`).type("form").send(body);
    expect(res.status).toBe(200);
    return res.text;
  }

  it("away-choice 1 rings the direct-line owner as normal (app first; v820 cell fallback still applies)", async () => {
    const xml = await awayChoice(`user=${OWNER}&ring=direct`, { Digits: "1", From: CALLER, CallSid: "CA-dnd-2" }, [
      [/SELECT sp\.twilio_identity FROM users u LEFT JOIN staff_presence sp/, { rows: [{ twilio_identity: OWNER }] }],
      [/WHERE u\.id::text = \$1\s+AND u\.callback_verified_at IS NOT NULL/, { rows: [{ phone: "4035550103" }] }],
    ]);
    expect(xml).toContain(`<Client>${OWNER}</Client>`);
    expect(xml).toContain('timeout="15"');
    expect(xml).toContain(`direct-unavailable?user=${OWNER}&amp;cell=1`);
  });

  it("away-choice with any other key goes to their voicemail", async () => {
    const xml = await awayChoice(`user=${OWNER}&ring=direct`, { Digits: "2", From: CALLER });
    expect(xml).toContain(`/api/webhooks/twilio/voicemail?staff=${OWNER}`);
    expect(xml).not.toContain("<Dial");
  });

  it("away-choice 1 for a named reception target rings that person", async () => {
    const xml = await awayChoice(`user=${ANDREW}&ring=underwriting`, { Digits: "1", From: CALLER }, [
      [/FROM users u JOIN staff_presence sp ON sp\.user_id = u\.id\s+WHERE \(u\.first_name ILIKE \$1/, { rows: [{
        status: "available", twilio_identity: "andrew-client", on_call: false, fresh: true, ringable: true, phone: null, standalone_watch: false, user_id: ANDREW,
      }] }],
    ]);
    expect(xml).toContain("<Client>andrew-client</Client>");
  });

  it("reception: a named target outside their hours gets the away prompt instead of ringing", async () => {
    h.query.mockImplementation(answerBySql([
      [/FROM users u JOIN staff_presence sp ON sp\.user_id = u\.id\s+WHERE \(u\.first_name ILIKE \$1/, { rows: [{
        status: "available", twilio_identity: "andrew-client", on_call: false, fresh: true, ringable: true, phone: null, standalone_watch: false, user_id: ANDREW,
      }] }],
      [HOURS_SQL, { rows: [awayRow({ user_id: ANDREW })] }],
    ]));
    const app = mountRouter((await import("../routes/reception.js")).default, "/api/webhooks/twilio/reception");
    const xml = (await request(app).post("/api/webhooks/twilio/reception/intent?company=BF").type("form").send({ Digits: "2", From: CALLER })).text;
    expect(xml).toContain("Andrew is away right now. To leave a voicemail, stay on the line. If this is urgent, press 1.");
    expect(xml).toContain(`away-choice?user=${ANDREW}&amp;ring=underwriting`);
    expect(xml).not.toContain("<Dial");
  });

  it("reception engagement group: members outside their hours are skipped, the rest ring", async () => {
    h.query.mockImplementation(answerBySql([
      [/FROM users u JOIN staff_presence sp ON sp\.user_id = u\.id\s+WHERE \(u\.first_name ILIKE \$1/, (_s: string, p?: unknown[]) => ({
        rows: String(p?.[0]).includes("todd")
          ? [{ status: "available", twilio_identity: "todd-client", on_call: false, fresh: true, ringable: true, phone: null, standalone_watch: false, user_id: OWNER }]
          : [],
      })],
      [/SELECT DISTINCT sp\.twilio_identity/, { rows: [{ twilio_identity: "staff-2" }, { twilio_identity: "staff-3" }] }],
      [GROUP_HOURS_SQL, { rows: [{ twilio_identity: "staff-2", enabled: true, timezone: EDMONTON, weekly: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } }] }],
    ]));
    const app = mountRouter((await import("../routes/reception.js")).default, "/api/webhooks/twilio/reception");
    const xml = (await request(app).post("/api/webhooks/twilio/reception/intent?company=BF").type("form").send({ Digits: "1", From: CALLER })).text;
    expect(xml).toContain("<Client>todd-client</Client>");
    expect(xml).toContain("<Client>staff-3</Client>");
    expect(xml).not.toContain("staff-2");
    expect(callsMatching(h.query, GROUP_HOURS_SQL)[0]![1]).toEqual([["todd-client", "staff-2", "staff-3"]]);
  });

  it("a broken call-hours lookup never stops a call from ringing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.query.mockImplementation(answerBySql([
      [/WHERE u\.direct_number = \$1/, { rows: [{ user_id: OWNER, first_name: "Pat", last_name: "Staff", twilio_identity: OWNER }] }],
      [HOURS_SQL, new Error("relation staff_call_hours does not exist")],
    ]));
    const app = mountRouter((await import("../routes/webhooks.js")).default, "/api/webhooks");
    const res = await request(app).post("/api/webhooks/twilio/voice/twiml").type("form").send({ From: CALLER, To: "+18255550190", CallSid: "CA-dnd-3" });
    expect(res.text).toContain(`<Client>${OWNER}</Client>`);
  });
});
