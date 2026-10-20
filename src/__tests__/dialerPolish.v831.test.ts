// BF_SERVER_v831_DIALER_POLISH - dialler audit batch 3:
//   - changes the dialler resends (outcomes, tasks, call logs, texts) run once (Idempotency-Key)
//   - Recents rows carry the call's sid and show unanswered incoming calls as missed
//   - incoming calls are logged with the caller in from_number
//   - the old summary route only shows calls the viewer was on
//   - caller ID covers every contact
//   - reception rings the right Todd / Andrew
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { bearer } from "./helpers/staffToken.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query, runQuery: h.query }));

import { replayKey, STALE_PENDING_SECONDS } from "../middleware/replayKey.js";
import { callerDirectory, directoryE164, directoryLabel } from "../voice/callerDirectory.js";

beforeEach(() => {
  h.query.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

/** dialer_request_keys in memory, answering by SQL content. */
function keyStore() {
  const rows = new Map<string, { scope: string; status_code: number | null; body: unknown; created: number }>();
  const id = (p: unknown[]) => `${p[0]}|${p[1]}`;
  const db = {
    rows,
    query: vi.fn(async (sql: string, p: unknown[] = []) => {
      if (/^\s*INSERT INTO dialer_request_keys/.test(sql)) {
        if (rows.has(id(p))) return { rows: [] };
        rows.set(id(p), { scope: String(p[2]), status_code: null, body: null, created: Date.now() });
        return { rows: [{ key: p[1] }] };
      }
      if (/SELECT scope, status_code, body/.test(sql)) {
        const r = rows.get(id(p));
        return { rows: r ? [{ ...r, stale: Date.now() - r.created > STALE_PENDING_SECONDS * 1000 }] : [] };
      }
      if (/UPDATE dialer_request_keys SET status_code/.test(sql)) {
        const r = rows.get(id(p));
        if (r) { r.status_code = Number(p[2]); r.body = JSON.parse(String(p[3])); }
        return { rows: [] };
      }
      if (/DELETE FROM dialer_request_keys WHERE user_id/.test(sql)) {
        const r = rows.get(id(p));
        if (r && r.status_code === null) rows.delete(id(p));
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
  return db;
}

function keyedApp(db: ReturnType<typeof keyStore>, handler: (req: any, res: any) => void) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { userId: "u-1" }; next(); });
  app.post("/thing", replayKey("thing", { db }), handler);
  return app;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("resent changes run once", () => {
  it("runs the first time, then answers a resend with the first result", async () => {
    const db = keyStore();
    let runs = 0;
    const app = keyedApp(db, (_req, res) => { runs += 1; res.status(201).json({ id: `task-${runs}` }); });
    const first = await request(app).post("/thing").set("Idempotency-Key", "6F9619FF-8B86-D011-B42D-00C04FC964FF").send({});
    await settle();
    const again = await request(app).post("/thing").set("Idempotency-Key", "6F9619FF-8B86-D011-B42D-00C04FC964FF").send({});
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ id: "task-1" });
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(runs).toBe(1);
  });

  it("a refused or failed request is not kept, so the resend runs again", async () => {
    const db = keyStore();
    let runs = 0;
    const app = keyedApp(db, (_req, res) => { runs += 1; res.status(runs === 1 ? 404 : 200).json({ runs }); });
    await request(app).post("/thing").set("Idempotency-Key", "key-aaaaaaaa").send({});
    await settle();
    const again = await request(app).post("/thing").set("Idempotency-Key", "key-aaaaaaaa").send({});
    expect(again.status).toBe(200);
    expect(runs).toBe(2);
  });

  it("says the change is still being saved while the first attempt runs", async () => {
    const db = keyStore();
    db.rows.set("u-1|key-bbbbbbbb", { scope: "thing", status_code: null, body: null, created: Date.now() });
    const app = keyedApp(db, (_req, res) => res.json({ ran: true }));
    const res = await request(app).post("/thing").set("Idempotency-Key", "key-bbbbbbbb").send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("request_in_progress");
  });

  it("takes over an attempt that never finished", async () => {
    const db = keyStore();
    db.rows.set("u-1|key-cccccccc", { scope: "thing", status_code: null, body: null, created: Date.now() - (STALE_PENDING_SECONDS + 5) * 1000 });
    const app = keyedApp(db, (_req, res) => res.json({ ran: true }));
    const res = await request(app).post("/thing").set("Idempotency-Key", "key-cccccccc").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ran: true });
  });

  it("leaves requests without a key alone and refuses a malformed key", async () => {
    const db = keyStore();
    const app = keyedApp(db, (_req, res) => res.json({ ran: true }));
    expect((await request(app).post("/thing").send({})).body).toEqual({ ran: true });
    expect(db.query).not.toHaveBeenCalled();
    expect((await request(app).post("/thing").set("Idempotency-Key", "bad key!").send({})).status).toBe(400);
  });

  it("still saves the change when the key store is down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = { query: vi.fn(async () => { throw new Error("down"); }) } as any;
    const app = keyedApp(db, (_req, res) => res.json({ ran: true }));
    expect((await request(app).post("/thing").set("Idempotency-Key", "key-dddddddd").send({})).body).toEqual({ ran: true });
    expect(warn).toHaveBeenCalled();
  });
});

describe("Recents", () => {
  it("returns each call's sid and marks unanswered incoming calls as missed", async () => {
    h.query.mockImplementation(answerBySql([[/FROM call_logs cl/, { rows: [] }]]));
    const { default: router } = await import("../routes/voiceCalls.js");
    const app = express();
    app.use(express.json());
    app.use("/api/voice", router);
    const res = await request(app).get("/api/voice/recent-calls").set("Authorization", bearer("Staff"));
    expect(res.status).toBe(200);
    const [sql] = callsMatching(h.query, /FROM call_logs cl/)[0]!;
    expect(String(sql)).toContain("sid AS call_sid");
    expect(String(sql)).toMatch(/cl\.direction = 'inbound' AND cl\.answered_leg_sid IS NULL[\s\S]*THEN 'missed'/);
  });
});

describe("call log from the dialler", () => {
  const app = async () => {
    const { default: router } = await import("../routes/communications.js");
    const a = express();
    a.use(express.json());
    a.use("/api/communications", router);
    return a;
  };

  it("an incoming call is logged with the caller as from_number and direction inbound", async () => {
    h.query.mockImplementation(answerBySql([
      [/SELECT id FROM contacts WHERE silo/, { rows: [] }],
      [/INSERT INTO call_events/, { rows: [{ id: "ev-1", occurred_at: "2026-10-20T15:00:00Z" }] }],
    ]));
    const res = await request(await app()).post("/api/communications/call-events").set("Authorization", bearer("Staff"))
      .send({ event_type: "call.ended", direction: "inbound", from_number: "+15875550142", duration_seconds: 42 });
    expect(res.status).toBe(201);
    const [, params] = callsMatching(h.query, /INSERT INTO call_events/)[0]!;
    expect((params as unknown[]).slice(5, 8)).toEqual(["inbound", "+15875550142", null]);
  });

  it("an unknown direction is dropped instead of failing; an outgoing call still needs to_number", async () => {
    h.query.mockImplementation(answerBySql([
      [/SELECT id FROM contacts WHERE silo/, { rows: [] }],
      [/INSERT INTO call_events/, { rows: [{ id: "ev-2", occurred_at: "2026-10-20T15:00:00Z" }] }],
    ]));
    const ok = await request(await app()).post("/api/communications/call-events").set("Authorization", bearer("Staff"))
      .send({ event_type: "call.ended", direction: "sideways", to_number: "+15875550142" });
    expect(ok.status).toBe(201);
    expect((callsMatching(h.query, /INSERT INTO call_events/)[0]![1] as unknown[])[5]).toBeNull();
    const missing = await request(await app()).post("/api/communications/call-events").set("Authorization", bearer("Staff"))
      .send({ event_type: "call.ended", direction: "outbound", from_number: "+15875550142" });
    expect(missing.status).toBe(400);
  });
});

describe("old call summary route", () => {
  it("refuses a call the viewer was not on", async () => {
    h.query.mockImplementation(answerBySql([
      [/viewer_on_call/, { rows: [{ created_by_user_id: "someone-else", viewer_on_call: false }] }],
    ]));
    const { default: router } = await import("../routes/calls.js");
    const app = express();
    app.use("/api/calls", router);
    const res = await request(app).get("/api/calls/summary?callSid=CA0123456789abcdef0123456789abcdef").set("Authorization", bearer("Staff"));
    expect(res.status).toBe(403);
  });

  it("the dialler's summary route now carries the suggested follow-ups", async () => {
    const { dialerCallSummary } = await import("../services/calls/autoCallSummary.js");
    const q = async () => ({ rows: [{ created_by_user_id: "u-1", viewer_on_call: true, voice_intelligence_summary: "Talked rates.",
      suggested_tasks: [{ title: "Send term sheet", type: "EMAIL", dueInDays: 2 }] }] });
    const out = await dialerCallSummary("CA0123456789abcdef0123456789abcdef", { userId: "u-1", isAdmin: false }, q as any);
    expect(out.body.suggestedTasks).toEqual([{ title: "Send term sheet", type: "EMAIL", dueInDays: 2 }]);
  });
});

describe("caller ID directory", () => {
  it("normalises numbers and skips placeholder names", () => {
    expect(directoryE164("(403) 555-0142")).toBe("+14035550142");
    expect(directoryE164("1-403-555-0142")).toBe("+14035550142");
    expect(directoryE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(directoryE164("555-0142")).toBeNull();
    expect(directoryLabel({ name: "Acme (application started)", first_name: "Jane", last_name: "Doe" })).toBe("Jane Doe");
    expect(directoryLabel({ name: "Unknown", company_name: "Acme Ltd" })).toBe("Acme Ltd");
    expect(directoryLabel({ name: " " })).toBeNull();
  });

  it("lists every number once, newest contact first, in the request's silo", async () => {
    const q = { query: vi.fn(async () => ({ rows: [
      { name: "Jane Doe", phone: "403-555-0142", secondary_phone: "587 555 0100" },
      { name: "Old Jane", phone: "+14035550142", secondary_phone: null },
    ] })) };
    expect(await callerDirectory(q, "BF")).toEqual([
      { number: "+14035550142", label: "Jane Doe" },
      { number: "+15875550100", label: "Jane Doe" },
    ]);
    expect((q.query.mock.calls[0] as unknown[])[1]).toEqual(["BF"]);
  });

  it("is served at /api/voice/caller-directory", async () => {
    h.query.mockImplementation(answerBySql([[/FROM contacts c\s+WHERE c\.silo = \$1 AND c\.merged_into_id IS NULL/, { rows: [{ name: "Jane Doe", phone: "4035550142" }] }]]));
    const { default: router } = await import("../routes/voiceCalls.js");
    const app = express();
    app.use("/api/voice", router);
    const res = await request(app).get("/api/voice/caller-directory").set("Authorization", bearer("Staff"));
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([{ number: "+14035550142", label: "Jane Doe" }]);
  });
});

describe("reception targets", () => {
  it("matches the exact first name, or the user id set in the environment", async () => {
    const { receptionFirstName, receptionUserId } = await import("../routes/reception.js");
    expect(receptionFirstName("sales")).toBe("todd");
    expect(receptionFirstName("underwriting")).toBe("andrew");
    vi.stubEnv("RECEPTION_SALES_USER_ID", "44444444-4444-4444-8444-444444444444");
    expect(receptionUserId("sales")).toBe("44444444-4444-4444-8444-444444444444");
    vi.stubEnv("RECEPTION_SALES_USER_ID", "not-an-id");
    expect(receptionUserId("sales")).toBeNull();
    vi.unstubAllEnvs();
  });
});
