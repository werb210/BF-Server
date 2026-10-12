// BF_SERVER_v789_BI_OUTREACH_VIA_API - bi_contacts is BI-Server's table, not this
// database's. The outreach auto-advance and the task-on-a-BI-lead promotion now
// call BI-Server over HTTP with a bi-server service token.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, logWarnMock } = vi.hoisted(() => ({ queryMock: vi.fn(), logWarnMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock } };
});
vi.mock("../observability/logger.js", () => ({ logInfo: vi.fn(), logError: vi.fn(), logWarn: logWarnMock }));
vi.mock("../modules/o365/todoSync.js", () => ({ mirrorTaskToTodo: vi.fn(async () => undefined) }));

const SECRET = "test-secret-v789-outreach";
const BI = "https://bi.test.local";
const STAFF_ID = "00000000-0000-0000-0000-0000000000a1";
const LEAD_ID = "11111111-2222-4333-8444-555555555555";

type Call = { url: string; method: string; body: any; auth: string };
const calls: Call[] = [];
let biMode: "ok" | "404" | "500" | "throw" = "ok";

function fakeFetch() {
  return vi.fn(async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null, auth: String(init.headers?.authorization ?? "") });
    if (biMode === "throw") throw new Error("connect ECONNREFUSED");
    if (biMode === "500") return new Response("boom", { status: 500 });
    if (url === `${BI}/api/v1/bi/internal/outreach/advance`) return new Response(JSON.stringify({ ok: true, advanced: 1 }), { status: 200 });
    if (url === `${BI}/api/v1/bi/internal/outreach/contacts/${LEAD_ID}`) {
      if (biMode === "404") return new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404 });
      return new Response(JSON.stringify({ full_name: "Lena Lead", email: "lena@lead.test", phone_e164: "+15555550199", company_id: "co-9" }), { status: 200 });
    }
    return new Response("unexpected url", { status: 599 });
  });
}

function dbAnswers(sql: string): { rows: any[]; rowCount: number } {
  const r = (rows: any[]) => ({ rows, rowCount: rows.length });
  if (/FROM users WHERE id = \$1/i.test(sql)) return r([{ id: STAFF_ID, role: "staff", silo: "BI", silos: ["BI"], is_active: true }]);
  if (/SELECT silo FROM contacts/i.test(sql)) return r([]);
  if (/SELECT id FROM contacts/i.test(sql)) return r([]);
  if (/INSERT INTO contacts/i.test(sql)) return r([{ id: "promoted-1" }]);
  if (/INSERT INTO tasks/i.test(sql)) return r([{ id: "task-1" }]);
  if (/INSERT INTO call_events/i.test(sql)) return r([{ id: "ce-1", occurred_at: "2026-10-11T00:00:00.000Z" }]);
  if (/bi_contacts/i.test(sql)) throw new Error("relation \"bi_contacts\" does not exist");
  return r([]);
}

beforeEach(() => {
  calls.length = 0;
  biMode = "ok";
  process.env.JWT_SECRET = SECRET;
  delete process.env.BI_SERVICE_JWT_SECRET;
  process.env.BI_SERVER_URL = BI;
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => dbAnswers(sql));
  logWarnMock.mockReset();
  vi.stubGlobal("fetch", fakeFetch());
});
afterEach(() => { vi.unstubAllGlobals(); });

function expectBiToken(auth: string) {
  const claims = jwt.verify(auth.replace(/^Bearer\s+/i, ""), SECRET, { algorithms: ["HS256"], issuer: "bf-server", audience: "bi-server" }) as any;
  expect(claims.kind).toBe("service");
}

describe("biOutreach advance helpers", () => {
  it("each bump posts {match, to} to BI's outreach/advance with a bi-server token, and never queries bi_contacts", async () => {
    const m = await import("../services/biOutreach.js");
    await m.bumpBiOutreachToContacted("c-1");
    await m.bumpBiOutreachToEngagedByPhone("+1 (555) 555-0101");
    await m.bumpBiOutreachToEngagedByEmail("  Lead@Example.COM ");
    await m.bumpBiOutreachToDemoBooked("c-2");
    expect(calls.map((c) => [c.url, c.method, c.body])).toEqual([
      [`${BI}/api/v1/bi/internal/outreach/advance`, "POST", { match: { id: "c-1" }, to: "contacted" }],
      [`${BI}/api/v1/bi/internal/outreach/advance`, "POST", { match: { phone: "+1 (555) 555-0101" }, to: "engaged" }],
      [`${BI}/api/v1/bi/internal/outreach/advance`, "POST", { match: { email: "lead@example.com" }, to: "engaged" }],
      [`${BI}/api/v1/bi/internal/outreach/advance`, "POST", { match: { id: "c-2" }, to: "demo_booked" }],
    ]);
    for (const c of calls) expectBiToken(c.auth);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("skips empty input without calling BI", async () => {
    const m = await import("../services/biOutreach.js");
    await m.bumpBiOutreachToContacted(null);
    await m.bumpBiOutreachToEngagedByPhone("no digits");
    await m.bumpBiOutreachToEngagedByEmail("   ");
    expect(calls).toHaveLength(0);
  });

  it("does not throw when BI fails or is unreachable, and logs it", async () => {
    const m = await import("../services/biOutreach.js");
    biMode = "500";
    await expect(m.bumpBiOutreachToContacted("c-1")).resolves.toBeUndefined();
    biMode = "throw";
    await expect(m.bumpBiOutreachToEngagedByEmail("a@b.co")).resolves.toBeUndefined();
    const events = logWarnMock.mock.calls.map((c) => c[0]);
    expect(events).toContain("bi_outreach_advance_http");
    expect(events).toContain("bi_outreach_advance_failed");
  });

  it("uses BI_SERVICE_JWT_SECRET when it is set", async () => {
    process.env.BI_SERVICE_JWT_SECRET = "bi-only-secret-v789";
    const m = await import("../services/biOutreach.js");
    await m.bumpBiOutreachToContacted("c-1");
    const tok = calls[0]!.auth.replace(/^Bearer\s+/i, "");
    expect(() => jwt.verify(tok, "bi-only-secret-v789", { algorithms: ["HS256"], audience: "bi-server" })).not.toThrow();
    delete process.env.BI_SERVICE_JWT_SECRET;
  });
});

const staffToken = () => jwt.sign({ id: STAFF_ID, role: "Staff", capabilities: ["communications:read"] }, SECRET);

describe("POST /api/communications/call-events (BI outbound)", () => {
  async function app() {
    const router = (await import("../routes/communications.js")).default;
    const a = express();
    a.use(express.json());
    a.use((_req, res, next) => { res.locals.silo = "BI"; next(); });
    a.use("/api/communications", router);
    return a;
  }

  it("asks BI to advance the dialed lead to contacted instead of updating bi_contacts", async () => {
    const res = await request(await app()).post("/api/communications/call-events")
      .set("Authorization", `Bearer ${staffToken()}`)
      .send({ event_type: "call.started", direction: "outbound", to_number: "+15555550123" });
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith("/outreach/advance"))).toBe(true));
    const call = calls.find((c) => c.url.endsWith("/outreach/advance"))!;
    expect(call.body).toEqual({ match: { phone: "+15555550123" }, to: "contacted" });
    expectBiToken(call.auth);
    expect(queryMock.mock.calls.some(([sql]) => /bi_contacts/i.test(String(sql)))).toBe(false);
  });

  it("still returns 201 when BI is down (non-blocking)", async () => {
    biMode = "throw";
    const res = await request(await app()).post("/api/communications/call-events")
      .set("Authorization", `Bearer ${staffToken()}`)
      .send({ event_type: "call.started", direction: "outbound", to_number: "+15555550123" });
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(logWarnMock.mock.calls.map((c) => c[0])).toContain("bi_outreach_advance_failed"));
  });
});

describe("POST /api/tasks on a BI outreach lead", () => {
  async function app() {
    const router = (await import("../routes/tasks.js")).default;
    const a = express();
    a.use(express.json());
    a.use("/api/tasks", router);
    return a;
  }
  const send = async () => request(await app()).post("/api/tasks")
    .set("Authorization", `Bearer ${staffToken()}`)
    .send({ title: "Call Lena", type: "CALL", contact_id: LEAD_ID });

  it("reads the lead from BI and promotes it into contacts", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    const get = calls.find((c) => c.url === `${BI}/api/v1/bi/internal/outreach/contacts/${LEAD_ID}`)!;
    expect(get.method).toBe("GET");
    expectBiToken(get.auth);
    const ins = queryMock.mock.calls.find(([sql]) => /INSERT INTO contacts/i.test(String(sql)))!;
    expect(ins[1]).toEqual(["Lena Lead", "lena@lead.test", "+15555550199"]);
    const task = queryMock.mock.calls.find(([sql]) => /INSERT INTO tasks/i.test(String(sql)))!;
    expect(task[1][0]).toBe("BI");
    expect(task[1][9]).toBe("promoted-1");
    expect(queryMock.mock.calls.some(([sql]) => /bi_contacts/i.test(String(sql)))).toBe(false);
  });

  it("BI 404 -> 400 contact_not_found", async () => {
    biMode = "404";
    const res = await send();
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("contact_not_found");
    expect(queryMock.mock.calls.some(([sql]) => /INSERT INTO/i.test(String(sql)))).toBe(false);
  });

  it("BI failure -> 502, nothing written", async () => {
    biMode = "500";
    const res = await send();
    expect(res.status).toBe(502);
    expect(queryMock.mock.calls.some(([sql]) => /INSERT INTO/i.test(String(sql)))).toBe(false);
  });
});
