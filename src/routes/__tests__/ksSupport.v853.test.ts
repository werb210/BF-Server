// BF_SERVER_v853_KS_PHONE_SUPPORT - /api/ks/support: the KS-Ops ingest (key, validation, create, append, idempotent),
// who may use the queue, listing with SLA states, assignment / status changes with notifications, notes, replies by
// SMS and email through the existing senders, and the Admin-only phone settings. Database faked by SQL content.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";
import { mountRouter, staffToken, STAFF_USER_ID } from "../../__tests__/helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  notify: vi.fn(async () => ({ smsSent: 0, notifsCreated: 1, recipientCount: 1 })),
  smsCreate: vi.fn(async () => ({ sid: "SM1", status: "queued" })),
  graph: vi.fn(async () => ({ ok: true, messageId: null })),
}));
vi.mock("../../db.js", async () => ({
  ...(await vi.importActual<any>("../../db.js")),
  pool: { query: h.query, connect: async () => ({ query: h.query, release: h.release }) },
  dbQuery: h.query,
}));
vi.mock("../../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: h.notify }));
vi.mock("../../lib/sharedClients.js", async (orig) => ({ ...(await orig<any>()), sharedTwilio: () => ({ messages: { create: h.smsCreate } }) }));
vi.mock("../../services/email/graphSendService.js", async (orig) => ({ ...(await orig<any>()), sendViaGraph: h.graph }));

const KEY = "k".repeat(40);
const TICKET = "33333333-3333-4333-8333-333333333333";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const CONTACT = "11111111-1111-4111-8111-111111111111";
const OTHER = "77777777-7777-4777-8777-777777777777";

async function app() {
  return mountRouter((await import("../ksSupport.js")).default, "/api/ks/support");
}
const admin = () => `Bearer ${staffToken("Admin")}`;
const users = (role: string, silos: string[]): SqlRule => [/FROM users WHERE id = \$1/, { rows: [{ id: STAFF_USER_ID, role, silo: "BF", silos, first_name: "Pat", last_name: "Admin", name: "Pat Admin" }] }];

const TICKET_ROW = {
  id: TICKET, number: 1001, company_id: COMPANY, contact_id: CONTACT, subject: "Cannot upload", channel: "in_app", priority: "normal",
  status: "open", assignee_user_id: null, support_level: "priority", sla_due_at: "2000-01-01T00:00:00Z", first_response_at: null,
  from_phone: null, from_email: "ada@acme.example", from_name: "Ada", external_source: "ks_ops", external_id: "t-1",
  last_message_at: "2026-10-21T16:00:00Z", resolved_at: null, closed_at: null, created_at: "2026-10-21T16:00:00Z", updated_at: "2026-10-21T16:00:00Z",
  company_name: "Acme Lending", company_support_level: "priority", company_plan: "pro", contact_name: "Ada Lovelace",
  contact_email: "ada@acme.example", contact_phone: "+14035550123", assignee_name: null, assignee_email: null, answered_at: null, message_count: 2,
};

function db(rules: SqlRule[] = []) {
  h.query.mockImplementation(answerBySql([
    ...rules,
    users("Admin", ["BF"]),
    [/pg_advisory_xact_lock/, { rows: [{}] }],
    [/FROM companies WHERE silo = 'KS' AND lower\(ks_company_code\)/, { rows: [{ id: COMPANY }] }],
    [/FROM contacts\s+WHERE silo = 'KS' AND lower\(email\)/, { rows: [{ id: CONTACT }] }],
    [/INSERT INTO ks_support_tickets/, { rows: [{ id: TICKET, number: 1001 }] }],
    [/INSERT INTO ks_support_ticket_messages/, { rows: [{ id: "66666666-6666-4666-8666-666666666666" }] }],
    [/FROM ks_support_tickets t/, { rows: [TICKET_ROW] }],
    [/FROM users u WHERE \(coalesce\(u\.active/, { rows: [{ id: OTHER }] }],
  ]));
}

beforeEach(() => {
  h.query.mockReset();
  h.notify.mockClear();
  h.smsCreate.mockClear();
  h.graph.mockClear();
  process.env.KS_OPS_CRM_KEY = KEY;
  process.env.KS_VOICE_NUMBER = "+15878750815";
  process.env.KS_SUPPORT_EMAIL = "support@keystone.example";
  db();
});
afterEach(() => {
  delete process.env.KS_OPS_CRM_KEY;
  delete process.env.KS_VOICE_NUMBER;
  delete process.env.KS_SUPPORT_EMAIL;
  vi.restoreAllMocks();
});

const ingest = async (body: unknown, key: string | null = KEY) => {
  const r = request(await app()).post("/api/ks/support/ingest");
  if (key !== null) r.set("X-KS-Ops-Key", key);
  return r.send(body as object);
};
const BODY = {
  external_id: "t-1", subject: "Cannot upload", message: "The upload button does nothing", message_id: "m-1",
  licensee: { company_code: "ACME", name: "Acme Lending", support_level: "priority" }, requester: { name: "Ada Lovelace", email: "ada@acme.example" },
};

describe("POST /api/ks/support/ingest", () => {
  it("is off without KS_OPS_CRM_KEY, and refuses a wrong key or a bad body before writing anything", async () => {
    delete process.env.KS_OPS_CRM_KEY;
    expect((await ingest(BODY)).status).toBe(503);
    process.env.KS_OPS_CRM_KEY = KEY;
    expect((await ingest(BODY, "nope")).status).toBe(401);
    expect((await ingest(BODY, null)).status).toBe(401);
    const bad = await ingest({ external_id: "", message: "" });
    expect(bad.status).toBe(400);
    expect(bad.body.errors).toHaveProperty("external_id");
    expect(callsMatching(h.query, /ks_support/)).toHaveLength(0);
  });

  it("creates an in-app ticket for the licensee and contact, with the SLA from their support level", async () => {
    const res = await ingest(BODY);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, ticket_id: TICKET, number: 1001, created: true, silo: "KS" });
    const [, p] = callsMatching(h.query, /INSERT INTO ks_support_tickets/)[0]!;
    const params = p as unknown[];
    expect(params.slice(0, 6)).toEqual([COMPANY, CONTACT, "Cannot upload", "in_app", "normal", "new"]);
    expect(params[7]).toBe("priority");
    expect(typeof params[8]).toBe("string"); // the SLA due time
    expect(params.slice(12, 14)).toEqual(["ks_ops", "t-1"]);
    expect(callsMatching(h.query, /UPDATE companies SET ks_support_level/)[0]![1]).toEqual([COMPANY, "priority"]);
    expect(callsMatching(h.query, /INSERT INTO crm_notes/)[0]![1]).toEqual(["Keystone support ticket #1001 opened (in-app): Cannot upload", CONTACT, null]);
    // Unassigned: the support team is told.
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ silo: "KS", userIds: [OTHER], title: "New Keystone support ticket #1001" }));
    expect(callsMatching(h.query, /^BEGIN$/)).toHaveLength(1);
    expect(callsMatching(h.query, /^COMMIT$/)).toHaveLength(1);
  });

  it("a follow-up message on the same KS-Ops ticket is appended (once) and reopens it", async () => {
    db([[/SELECT id::text AS id, number FROM ks_support_tickets WHERE external_source/, { rows: [{ id: TICKET, number: 1001 }] }]]);
    const res = await ingest({ ...BODY, message: "Still broken", message_id: "m-2" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: false, appended: true });
    expect(callsMatching(h.query, /INSERT INTO ks_support_tickets/)).toHaveLength(0);
    const [, msg] = callsMatching(h.query, /INSERT INTO ks_support_ticket_messages/)[0]!;
    expect((msg as unknown[]).slice(0, 4)).toEqual([TICKET, "customer", "in_app", "Still broken"]);
    expect((msg as unknown[])[8]).toBe("m-2");
    expect(callsMatching(h.query, /status IN \('waiting', 'resolved'\) THEN 'open'/)).toHaveLength(1);
    // The same message again: nothing new.
    db([
      [/SELECT id::text AS id, number FROM ks_support_tickets WHERE external_source/, { rows: [{ id: TICKET, number: 1001 }] }],
      [/INSERT INTO ks_support_ticket_messages/, { rows: [] }],
    ]);
    const again = await ingest({ ...BODY, message: "Still broken", message_id: "m-2" });
    expect(again.body).toMatchObject({ created: false, appended: false });
  });
});

describe("staff access", () => {
  it("Admins and staff with Keystone access only", async () => {
    db([users("Staff", ["BF", "BI"])]);
    expect((await request(await app()).get("/api/ks/support/tickets").set("Authorization", `Bearer ${staffToken("Staff")}`)).status).toBe(403);
    db([users("Staff", ["BF", "KS"])]);
    expect((await request(await app()).get("/api/ks/support/tickets").set("Authorization", `Bearer ${staffToken("Staff")}`)).status).toBe(200);
    expect((await request(await app()).get("/api/ks/support/tickets")).status).toBe(401);
  });
});

describe("the queue", () => {
  it("lists active tickets with their SLA state, filtered as asked", async () => {
    const res = await request(await app()).get("/api/ks/support/tickets?assignee=unassigned&priority=high&q=%231001").set("Authorization", admin());
    expect(res.status).toBe(200);
    expect(res.body.silo).toBe("KS");
    expect(res.body.tickets[0]).toMatchObject({ id: TICKET, number: 1001, status_label: "Open", sla_state: "overdue", support_level_label: "Priority", silo: "KS" });
    const [sql, params] = callsMatching(h.query, /FROM ks_support_tickets t/)[0]!;
    expect(String(sql)).toContain("t.status IN ('new', 'open', 'waiting')");
    expect(String(sql)).toContain("t.assignee_user_id IS NULL");
    expect(params).toEqual(["high", "%#1001%", 1001]);
  });

  it("shows a ticket with its thread; an unknown id is a 404", async () => {
    db([[/FROM ks_support_ticket_messages m\s+LEFT JOIN users au/, { rows: [
      { id: "m1", kind: "call", channel: "phone", body: "Support line call", call_sid: "CA1", created_at: "2026-10-21T16:00:00Z", call_status: "completed", call_duration: 95, call_answered: true, call_answered_by: "Sam Support", call_summary: "- Upload fixed", call_transcript: "hello" },
      { id: "m2", kind: "note", channel: "internal", body: "Checked logs", author_name: "Pat Admin", created_at: "2026-10-21T16:05:00Z" },
    ] }]]);
    const res = await request(await app()).get(`/api/ks/support/tickets/${TICKET}`).set("Authorization", admin());
    expect(res.status).toBe(200);
    expect(res.body.ticket.number).toBe(1001);
    expect(res.body.messages[0].call).toMatchObject({ answered: true, answered_by: "Sam Support", summary: "- Upload fixed", duration_seconds: 95 });
    expect(res.body.messages[1].call).toBeUndefined();
    db([[/FROM ks_support_tickets t/, { rows: [] }]]);
    expect((await request(await app()).get(`/api/ks/support/tickets/${TICKET}`).set("Authorization", admin())).status).toBe(404);
  });

  it("assigning to someone without Keystone access is refused; assigning to Keystone staff notifies them", async () => {
    db([
      [/FROM ks_support_tickets WHERE id = \$1::uuid/, { rows: [{ id: TICKET, number: 1001, subject: "Cannot upload", status: "new", priority: "normal", assignee_user_id: null, contact_id: CONTACT, company_id: COMPANY }] }],
      [/SELECT 1 FROM users u WHERE u\.id = \$1::uuid/, { rows: [] }],
    ]);
    const refused = await request(await app()).patch(`/api/ks/support/tickets/${TICKET}`).set("Authorization", admin()).send({ assignee_user_id: OTHER });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("assignee_not_keystone_staff");

    db([
      [/FROM ks_support_tickets WHERE id = \$1::uuid/, { rows: [{ id: TICKET, number: 1001, subject: "Cannot upload", status: "new", priority: "normal", assignee_user_id: null, contact_id: CONTACT, company_id: COMPANY }] }],
      [/SELECT 1 FROM users u WHERE u\.id = \$1::uuid/, { rows: [{ "?column?": 1 }] }],
    ]);
    const ok = await request(await app()).patch(`/api/ks/support/tickets/${TICKET}`).set("Authorization", admin()).send({ assignee_user_id: OTHER, priority: "high" });
    expect(ok.status).toBe(200);
    const [sql, params] = callsMatching(h.query, /UPDATE ks_support_tickets SET/)[0]!;
    expect(String(sql)).toContain("assignee_user_id = $3::uuid");
    expect(String(sql)).toContain("status = $4");
    expect(params).toEqual([TICKET, "high", OTHER, "open"]);
    expect(callsMatching(h.query, /INSERT INTO ks_support_ticket_messages/)[0]![1]).toEqual(expect.arrayContaining(["system", "Priority: normal -> high; Assigned (by Pat Admin)"]));
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ userIds: [OTHER], title: "Keystone ticket #1001 assigned to you" }));
  });

  it("resolving a ticket notes it on the contact's Keystone timeline", async () => {
    db([[/FROM ks_support_tickets WHERE id = \$1::uuid/, { rows: [{ id: TICKET, number: 1001, subject: "Cannot upload", status: "open", priority: "normal", assignee_user_id: null, contact_id: CONTACT, company_id: COMPANY }] }]]);
    const res = await request(await app()).patch(`/api/ks/support/tickets/${TICKET}`).set("Authorization", admin()).send({ status: "resolved" });
    expect(res.status).toBe(200);
    expect(String(callsMatching(h.query, /UPDATE ks_support_tickets SET/)[0]![0])).toContain("resolved_at = now()");
    expect(callsMatching(h.query, /INSERT INTO crm_notes/)[0]![1]).toEqual(["Keystone support ticket #1001 resolved: Cannot upload", CONTACT, null]);
  });

  it("adds an internal note", async () => {
    db([[/SELECT 1 FROM ks_support_tickets WHERE id/, { rows: [{ "?column?": 1 }] }]]);
    const res = await request(await app()).post(`/api/ks/support/tickets/${TICKET}/notes`).set("Authorization", admin()).send({ body: "Checked the logs" });
    expect(res.status).toBe(201);
    expect((callsMatching(h.query, /INSERT INTO ks_support_ticket_messages/)[0]![1] as unknown[]).slice(1, 4)).toEqual(["note", "internal", "Checked the logs"]);
  });
});

describe("replies", () => {
  it("replies by SMS from the Keystone number, records it on the ticket and in the KS SMS thread, and starts the SLA clock", async () => {
    const res = await request(await app()).post(`/api/ks/support/tickets/${TICKET}/reply`).set("Authorization", admin()).send({ channel: "sms", body: "Fixed - please try again" });
    expect(res.status).toBe(201);
    expect(res.body.to).toBe("+14035550123");
    expect(h.smsCreate).toHaveBeenCalledWith(expect.objectContaining({ to: "+14035550123", from: "+15878750815", body: "Fixed - please try again" }));
    expect(String(callsMatching(h.query, /INSERT INTO communications_messages/)[0]![0])).toContain("'KS'");
    expect((callsMatching(h.query, /INSERT INTO ks_support_ticket_messages/)[0]![1] as unknown[]).slice(1, 4)).toEqual(["reply", "sms", "Fixed - please try again"]);
    const [sql, params] = callsMatching(h.query, /first_response_at = coalesce\(first_response_at, now\(\)\)/)[0]!;
    expect(String(sql)).toContain("status = $2");
    expect(params).toEqual([TICKET, "waiting"]);
  });

  it("replies by email from the Keystone support mailbox through Graph", async () => {
    const res = await request(await app()).post(`/api/ks/support/tickets/${TICKET}/reply`).set("Authorization", admin()).send({ channel: "email", body: "Hello\nFixed", status: "resolved" });
    expect(res.status).toBe(201);
    expect(h.graph).toHaveBeenCalledWith(expect.objectContaining({ to: "ada@acme.example", subject: "Re: [Keystone #1001] Cannot upload", sendAs: "support@keystone.example" }));
    expect(callsMatching(h.query, /INSERT INTO crm_email_log/)[0]![1]).toEqual(expect.arrayContaining(["support@keystone.example", ["ada@acme.example"], "Hello<br/>Fixed"]));
  });

  it("a failed send is reported and nothing is recorded", async () => {
    h.graph.mockResolvedValueOnce({ ok: false, error: "graph_send_failed status=403" } as any);
    const res = await request(await app()).post(`/api/ks/support/tickets/${TICKET}/reply`).set("Authorization", admin()).send({ channel: "email", body: "Hi" });
    expect(res.status).toBe(502);
    expect(res.body.message).toContain("403");
    expect(callsMatching(h.query, /INSERT INTO ks_support_ticket_messages/)).toHaveLength(0);
  });
});

describe("phone settings", () => {
  it("shows the line and the URLs Twilio needs", async () => {
    const res = await request(await app()).get("/api/ks/support/phone").set("Authorization", admin());
    expect(res.body).toMatchObject({ configured: true, number: "+15878750815" });
    expect(res.body.voice_url).toMatch(/\/api\/webhooks\/twilio\/ks\/voice$/);
    expect(res.body.queues.map((q: any) => q.queue)).toEqual(["sales", "support"]);
  });

  it("only Admins change a queue, and everyone in a ring group needs Keystone access", async () => {
    db([users("Staff", ["KS"])]);
    expect((await request(await app()).put("/api/ks/support/phone/queues/support").set("Authorization", `Bearer ${staffToken("Staff")}`).send({ ringTimeoutSeconds: 30 })).status).toBe(403);
    db([[/SELECT 1 FROM users u WHERE u\.id = \$1::uuid/, { rows: [] }]]);
    const refused = await request(await app()).put("/api/ks/support/phone/queues/support").set("Authorization", admin()).send({ ringUserIds: [OTHER] });
    expect(refused.status).toBe(400);
    db([
      [/SELECT 1 FROM users u WHERE u\.id = \$1::uuid/, { rows: [{ "?column?": 1 }] }],
      [/INSERT INTO ks_phone_queues/, (_s: string, p?: unknown[]) => ({ rows: [{ queue: "support", label: "Support", ring_user_ids: p?.[2], ring_timeout_seconds: p?.[3], hours_enabled: p?.[4], timezone: p?.[5], weekly: JSON.parse(String(p?.[6])) }] })],
    ]);
    const ok = await request(await app()).put("/api/ks/support/phone/queues/support").set("Authorization", admin()).send({ ringUserIds: [OTHER], ringTimeoutSeconds: 30 });
    expect(ok.status).toBe(200);
    expect(ok.body.queue).toMatchObject({ queue: "support", ringUserIds: [OTHER], ringTimeoutSeconds: 30, hoursEnabled: true });
    expect((await request(await app()).put("/api/ks/support/phone/queues/billing").set("Authorization", admin()).send({})).status).toBe(404);
  });
});
