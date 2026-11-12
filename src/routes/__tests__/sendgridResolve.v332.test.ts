// BF_SERVER_SENDGRID_RESOLVE_v332
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: queryMock }, runQuery: queryMock }));
vi.mock("../../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn(async () => undefined) }));

const LOOKUP = /SELECT id FROM contacts/;
const TIMELINE = /INSERT INTO crm_timeline_events/;
const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PUBLIC_KEY = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");

// Contacts by stored address: primary and secondary.
const CONTACTS: Record<string, string> = { "ann@acme.test": "c-ann", "ann.alt@acme.test": "c-ann" };

async function post(events: unknown[]) {
  const { default: router } = await import("../sendgridWebhook.js");
  const app = express();
  app.use("/webhook", router);
  const body = JSON.stringify(events);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createSign("sha256").update(ts + body).sign(keys.privateKey, "base64");
  return request(app)
    .post("/webhook")
    .set("Content-Type", "application/json")
    .set("X-Twilio-Email-Event-Webhook-Signature", signature)
    .set("X-Twilio-Email-Event-Webhook-Timestamp", ts)
    .send(body);
}

describe("an email event finds its contact", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = PUBLIC_KEY;
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([[LOOKUP, (_sql: string, p?: unknown[]) => ({ rows: CONTACTS[String(p?.[0])] ? [{ id: CONTACTS[String(p?.[0])] }] : [] })]]));
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => log.mockRestore());

  it("matches primary or secondary email, trimmed, preferring the primary address", async () => {
    const res = await post([{ email: "ANN.ALT@acme.test", event: "open", sg_event_id: "e1" }]);
    expect(res.status).toBe(200);
    const lookup = callsMatching(queryMock, LOOKUP);
    expect(lookup[0]![1]).toEqual(["ann.alt@acme.test"]);
    const sql = String(lookup[0]![0]);
    expect(sql).toContain("lower(trim(coalesce(email, ''))) = $1");
    expect(sql).toContain("lower(trim(coalesce(secondary_email, ''))) = $1");
    expect(sql).toContain("ORDER BY (lower(trim(coalesce(email, ''))) = $1) DESC, created_at");
    const timeline = callsMatching(queryMock, TIMELINE);
    expect(timeline).toHaveLength(1);
    expect((timeline[0]![1] as unknown[]).slice(0, 2)).toEqual(["c-ann", "email_open"]);
  });

  it("trusts contact_id first", async () => {
    await post([{ email: "nobody@else.test", contact_id: "c-explicit", event: "click", url: "https://boreal.financial/x" }]);
    expect(callsMatching(queryMock, LOOKUP)).toHaveLength(0);
    const timeline = callsMatching(queryMock, TIMELINE);
    expect((timeline[0]![1] as unknown[]).slice(0, 2)).toEqual(["c-explicit", "email_click"]);
  });

  it("rejects an unsigned post", async () => {
    const { default: router } = await import("../sendgridWebhook.js");
    const app = express();
    app.use("/webhook", router);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await request(app).post("/webhook").set("Content-Type", "application/json").send(JSON.stringify([{ email: "ann@acme.test", event: "unsubscribe" }]));
      expect(res.status).toBe(403);
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});

describe("an unresolved event is visible", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = PUBLIC_KEY;
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([[LOOKUP, { rows: [] }]]));
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => log.mockRestore());

  function acceptedSummary() {
    const call = (log.mock.calls as unknown[][]).find((c) => c[0] === "[sendgrid-webhook] accepted");
    expect(call).toBeTruthy();
    return call![1] as Record<string, unknown>;
  }

  it("counts and names failed addresses, capping the sample, and still skips the event", async () => {
    const events = Array.from({ length: 7 }, (_, i) => ({ email: `ghost${i}@nowhere.test`, event: "delivered" }));
    const res = await post([...events, { email: "ghost0@nowhere.test", event: "open" }]);
    expect(res.status).toBe(200);
    const summary = acceptedSummary();
    expect(summary.contactsUnresolved).toBe(7);
    expect(summary.contactsResolved).toBe(0);
    expect(String(summary.unresolvedSample).split(",")).toEqual(["ghost0@nowhere.test", "ghost1@nowhere.test", "ghost2@nowhere.test", "ghost3@nowhere.test", "ghost4@nowhere.test"]);
    expect(callsMatching(queryMock, TIMELINE)).toHaveLength(0);
  });
});

// BF_SERVER_v945_EMAIL_SUPPRESSIONS
describe("an unsubscribe is remembered by address", () => {
  const SUPPRESS = /INSERT INTO email_suppressions/;
  const OPT_OUT_ALL = /UPDATE contacts SET marketing_opt_out = true[\s\S]*secondary_email/;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = PUBLIC_KEY;
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([[LOOKUP, (_sql: string, p?: unknown[]) => ({ rows: CONTACTS[String(p?.[0])] ? [{ id: CONTACTS[String(p?.[0])] }] : [] })]]));
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => log.mockRestore());

  it("records the address even when no contact matches, so a later import cannot email it", async () => {
    const res = await post([{ email: "Stranger@nowhere.test", event: "unsubscribe", sg_event_id: "u1" }]);
    expect(res.status).toBe(200);
    expect(callsMatching(queryMock, SUPPRESS)[0]![1]).toEqual(["stranger@nowhere.test", "unsubscribe"]);
    expect(callsMatching(queryMock, OPT_OUT_ALL)[0]![1]).toEqual(["stranger@nowhere.test"]);
    expect(callsMatching(queryMock, TIMELINE)).toHaveLength(0);
    expect(log.mock.calls.at(-1)![1]).toMatchObject({ contactsUnresolved: 1, suppressed: 1 });
  });

  it("opts out every contact with the address, leaving Keystone prospects to their own list", async () => {
    await post([{ email: "ann@acme.test", event: "spamreport", sg_event_id: "s1" }]);
    const sql = String(callsMatching(queryMock, OPT_OUT_ALL)[0]![0]);
    expect(sql).not.toMatch(/LIMIT 1/);
    expect(sql).toMatch(/coalesce\(silo, 'BF'\) <> 'KS'/);
  });

  it("does not suppress on an open, a click or a soft bounce", async () => {
    await post([{ email: "ann@acme.test", event: "open" }, { email: "ann@acme.test", event: "click", url: "https://x.test" }, { email: "ann@acme.test", event: "bounce", type: "blocked" }]);
    expect(callsMatching(queryMock, SUPPRESS)).toHaveLength(0);
  });

  it("does suppress on a hard bounce", async () => {
    await post([{ email: "gone@acme.test", event: "bounce", type: "bounce" }]);
    expect(callsMatching(queryMock, SUPPRESS)[0]![1]).toEqual(["gone@acme.test", "bounce"]);
  });
});

