// BF_SERVER_v821_DIALER - quick replies (GET /api/templates/quick) and the Siri Shortcuts data
// (GET /api/staff/next-follow-up, GET /api/staff/missed-summary).
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";
import { mountRouter, staffToken, STAFF_USER_ID } from "./helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query, runQuery: h.query }));

const CONTACT = "c0c0c0c0-0000-4000-8000-000000000002";
const TASK = "d0d0d0d0-0000-4000-8000-000000000003";
const auth = () => ({ Authorization: `Bearer ${staffToken("Staff")}` });

beforeEach(() => { h.query.mockReset(); h.query.mockImplementation(answerBySql([])); });
afterEach(() => { vi.restoreAllMocks(); });

describe("quick replies", () => {
  const app = async () => mountRouter((await import("../routes/templates.js")).default, "/api/templates");
  const QUICK = /SELECT id::text AS id, name, COALESCE\(NULLIF\(body_text, ''\), body_html, ''\) AS body, is_snippet/;

  it("GET /api/templates?channel=sms already returns templates AND snippets (no is_snippet filter without ?snippets)", async () => {
    await request(await app()).get("/api/templates").query({ channel: "sms" }).set(auth());
    const [sql, params] = callsMatching(h.query, /FROM message_templates/)[0]!;
    expect(sqlText(sql)).toContain("($4::boolean IS NULL OR is_snippet = $4)");
    expect(params).toEqual(["BF", STAFF_USER_ID, "sms", null]);
  });

  it("GET /api/templates/quick?channel=sms: {id, name, raw body, isSnippet}, snippets first then name, max 50", async () => {
    h.query.mockImplementation(answerBySql([[QUICK, { rows: [
      { id: "s1", name: "On my way", body: "Hi {{contact.first_name}}, calling you in 5.", is_snippet: true },
      { id: "t1", name: "Docs reminder", body: "<p>Hi {{contact.first_name}},</p><p>Please upload your statements &amp; ID.</p>", is_snippet: false },
    ] }]]));
    const res = await request(await app()).get("/api/templates/quick").query({ channel: "sms" }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [
      { id: "s1", name: "On my way", body: "Hi {{contact.first_name}}, calling you in 5.", isSnippet: true },
      { id: "t1", name: "Docs reminder", body: "Hi {{contact.first_name}},\nPlease upload your statements & ID.", isSnippet: false },
    ] });
    const [sql, params] = callsMatching(h.query, QUICK)[0]!;
    expect(sqlText(sql)).toMatch(/ORDER BY is_snippet DESC, name ASC\s+LIMIT 50/);
    expect(sqlText(sql)).toContain("(shared = true OR owner_user_id = $2)");
    expect(params).toEqual(["BF", STAFF_USER_ID, "sms"]);
  });

  it("defaults to sms, rejects unknown channels, requires a sign-in", async () => {
    await request(await app()).get("/api/templates/quick").set(auth());
    expect((callsMatching(h.query, QUICK)[0]![1] as unknown[])[2]).toBe("sms");
    expect((await request(await app()).get("/api/templates/quick").query({ channel: "fax" }).set(auth())).status).toBe(400);
    expect((await request(await app()).get("/api/templates/quick")).status).toBe(401);
  });
});

describe("GET /api/staff/next-follow-up", () => {
  const app = async () => mountRouter((await import("../routes/staffDialer.js")).nextFollowUpRouter, "/api/staff/next-follow-up");
  const NEXT = /FROM tasks t\s+JOIN contacts c ON c\.id = t\.contact_id/;

  it("the most urgent open task with a callable contact, phone in E.164", async () => {
    h.query.mockImplementation(answerBySql([[NEXT, { rows: [
      { task_id: TASK, title: "Call about statements", due_at: "2026-10-16T16:00:00Z", contact_id: CONTACT, contact_name: "Jane Client", phone: "(403) 555-0144" },
    ] }]]));
    const res = await request(await app()).get("/api/staff/next-follow-up").set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ found: true, taskId: TASK, title: "Call about statements", contactId: CONTACT, contactName: "Jane Client", phone: "+14035550144", dueAt: "2026-10-16T16:00:00.000Z" });
    const [sql, params] = callsMatching(h.query, NEXT)[0]!;
    expect(params).toEqual([STAFF_USER_ID]);
    expect(sqlText(sql)).toMatch(/ORDER BY \(t\.due_at IS NOT NULL AND t\.due_at < now\(\)\) DESC,\s+t\.due_at ASC NULLS LAST/);
    expect(sqlText(sql)).toContain("t.deleted_at IS NULL");
    expect(sqlText(sql)).toContain("t.status NOT IN ('COMPLETED', 'DEFERRED')");
  });

  it("skips a contact whose number is not callable; found:false when nothing is due", async () => {
    h.query.mockImplementation(answerBySql([[NEXT, { rows: [
      { task_id: "x", title: "Bad number", due_at: null, contact_id: CONTACT, contact_name: null, phone: "12345678901234" },
      { task_id: TASK, title: "Undated", due_at: null, contact_id: CONTACT, contact_name: null, phone: "4035550144" },
    ] }]]));
    expect((await request(await app()).get("/api/staff/next-follow-up").set(auth())).body).toEqual({ found: true, taskId: TASK, title: "Undated", contactId: CONTACT, phone: "+14035550144" });
    h.query.mockImplementation(answerBySql([]));
    expect((await request(await app()).get("/api/staff/next-follow-up").set(auth())).body).toEqual({ found: false });
    expect((await request(await app()).get("/api/staff/next-follow-up")).status).toBe(401);
  });
});

describe("GET /api/staff/missed-summary", () => {
  const app = async () => mountRouter((await import("../routes/staffDialer.js")).missedSummaryRouter, "/api/staff/missed-summary");

  it("missed calls (my bell, 24 h), unread client messages (silo), voicemails (my inbox scope, 24 h)", async () => {
    h.query.mockImplementation(answerBySql([
      [/FROM notifications n/, { rows: [
        { body: "Missed call from Jane Client", created_at: "2026-10-17T15:00:00Z", ref_id: "CA1", from_number: "+14035550144", phone_number: null },
        { body: "Missed call from +14035550155", created_at: "2026-10-17T14:00:00Z", ref_id: null, from_number: null, phone_number: null },
      ] }],
      [/FROM communications_messages m/, { rows: [
        { contact_id: CONTACT, body: "x".repeat(300), type: "sms", created_at: "2026-10-17T15:30:00Z", from_number: "+14035550144", contact_name: "Jane Client" },
        { contact_id: "c1c1c1c1-0000-4000-8000-000000000009", body: "Uploaded my ID", type: "message", created_at: "2026-10-17T13:00:00Z", from_number: null, contact_name: null },
      ] }],
      [/FROM voicemails v/, { rows: [
        { created_at: "2026-10-17T12:00:00Z", from_number: "+14035550166", transcript: "Please call me back", contact_name: "Unknown caller", contact_phone: null },
      ] }],
    ]));
    const res = await request(await app()).get("/api/staff/missed-summary").set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      missedCalls: [
        { name: "Jane Client", phone: "+14035550144", at: "2026-10-17T15:00:00.000Z" },
        { name: "+14035550155", phone: "+14035550155", at: "2026-10-17T14:00:00.000Z" },
      ],
      unreadMessages: [
        { name: "Jane Client", contactId: CONTACT, preview: `${"x".repeat(99)}…`, at: "2026-10-17T15:30:00.000Z", kind: "sms" },
        { name: "Unknown", contactId: "c1c1c1c1-0000-4000-8000-000000000009", preview: "Uploaded my ID", at: "2026-10-17T13:00:00.000Z", kind: "messages" },
      ],
      voicemails: [{ name: "+14035550166", phone: "+14035550166", at: "2026-10-17T12:00:00.000Z", excerpt: "Please call me back" }],
    });
    const calls = callsMatching(h.query, /FROM notifications n/)[0]!;
    expect(calls[1]).toEqual([STAFF_USER_ID]);
    expect(sqlText(calls[0])).toMatch(/n\.type = 'call_missed'\s+AND n\.created_at > now\(\) - interval '24 hours'[\s\S]*LIMIT 5/);
    const msgs = callsMatching(h.query, /FROM communications_messages m/)[0]!;
    expect(msgs[1]).toEqual(["BF"]);
    expect(sqlText(msgs[0])).toMatch(/m\.direction = 'inbound'\s+AND m\.read_at IS NULL/);
    expect(sqlText(msgs[0])).toContain("LIMIT 5");
    const vms = callsMatching(h.query, /FROM voicemails v/)[0]!;
    expect(vms[1]).toEqual(["BF", STAFF_USER_ID]);
    expect(sqlText(vms[0])).toContain("(v.staff_user_id::text = $2 OR v.staff_user_id IS NULL)");
  });

  it("empty lists; 401 without a sign-in", async () => {
    expect((await request(await app()).get("/api/staff/missed-summary").set(auth())).body).toEqual({ missedCalls: [], unreadMessages: [], voicemails: [] });
    expect((await request(await app()).get("/api/staff/missed-summary")).status).toBe(401);
  });
});

describe("route registry", () => {
  it("mounts the staff dialler paths ahead of /staff and lists every v821 route", async () => {
    const { API_ROUTE_MOUNTS, ROUTES } = await import("../routes/routeRegistry.js");
    const paths = API_ROUTE_MOUNTS.map((m) => m.path);
    for (const p of ["/staff/next-follow-up", "/staff/missed-summary", "/staff/call-hours"]) {
      expect(paths.indexOf(p)).toBeGreaterThanOrEqual(0);
      expect(paths.indexOf(p)).toBeLessThan(paths.indexOf("/staff"));
    }
    const listed = ROUTES.map((r) => `${r.method} ${r.path}`);
    for (const r of ["GET /api/calls/:callSid/summary", "GET /api/voice/caller-card", "GET /api/templates/quick", "GET /api/staff/next-follow-up",
      "GET /api/staff/missed-summary", "GET /api/staff/call-hours", "PUT /api/staff/call-hours", "POST /api/webhooks/twilio/reception/away-choice",
      "POST /api/webhooks/twilio/reception/leg-status", "POST /api/webhooks/twilio/reception/recording-notice"]) {
      expect(listed).toContain(r);
    }
  }, 60_000); // the registry imports every router
});
