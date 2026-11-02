// BF_SERVER_v865_KS_MARKETING - /api/ks/marketing (KS-Ops key only): Keystone CRM contacts out, marketing timeline in
// (once per key, contact created when missing, opt-out on unsubscribe), and the SendGrid webhook leaving Keystone
// marketing events to KS-Ops. Database faked by SQL content.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";
import { mountRouter } from "../../__tests__/helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), claimed: new Set<string>() }));
vi.mock("../../db.js", async () => ({
  ...(await vi.importActual<any>("../../db.js")),
  pool: { query: h.query, connect: async () => ({ query: h.query, release: h.release }) },
  dbQuery: h.query,
}));

const KEY = "k".repeat(40);
const CONTACT = "11111111-1111-4111-8111-111111111111";

async function app() {
  return mountRouter((await import("../ksMarketing.js")).default, "/api/ks/marketing");
}

function db(rules: SqlRule[] = []) {
  h.query.mockImplementation(answerBySql([
    ...rules,
    [/INSERT INTO ks_crm_timeline_keys/, (_sql: string, params?: unknown[]) => {
      const k = String(params?.[0]);
      if (h.claimed.has(k)) return { rows: [] };
      h.claimed.add(k);
      return { rows: [{ dedupe_key: k }] };
    }],
    [/INSERT INTO crm_notes/, { rows: [{ id: "22222222-2222-4222-8222-222222222222" }] }],
  ]));
}

beforeEach(() => {
  h.query.mockReset();
  h.claimed.clear();
  process.env.KS_OPS_CRM_KEY = KEY;
  db();
});
afterEach(() => {
  delete process.env.KS_OPS_CRM_KEY;
});

describe("the KS-Ops key", () => {
  it("is required, and the endpoint is off when it is not set", async () => {
    expect((await request(await app()).get("/api/ks/marketing/contacts")).status).toBe(401);
    expect((await request(await app()).get("/api/ks/marketing/contacts").set("X-KS-Ops-Key", "wrong")).status).toBe(401);
    delete process.env.KS_OPS_CRM_KEY;
    expect((await request(await app()).get("/api/ks/marketing/contacts").set("X-KS-Ops-Key", KEY)).status).toBe(503);
  });
});

describe("GET /contacts", () => {
  it("reads Keystone contacts only, changed since the cursor, oldest first", async () => {
    db([[/FROM contacts c/, { rows: [{ id: CONTACT, email: "jo@acme.example", ks_stage: "lost", marketing_opt_out: false }] }]]);
    const r = await request(await app()).get("/api/ks/marketing/contacts?since=2026-10-01T00:00:00Z&limit=50").set("X-KS-Ops-Key", KEY);
    expect(r.status).toBe(200);
    expect(r.body.contacts[0]).toMatchObject({ email: "jo@acme.example", ks_stage: "lost" });
    const [sql, params] = callsMatching(h.query, /FROM contacts c/)[0] as [string, unknown[]];
    expect(sql).toMatch(/c\.silo = 'KS'/);
    expect(sql).toMatch(/ORDER BY c\.updated_at ASC/);
    expect((params[0] as Date).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(params[1]).toBe(50);
  });
});

describe("POST /events", () => {
  const send = async (body: object) => request(await app()).post("/api/ks/marketing/events").set("X-KS-Ops-Key", KEY).send(body);
  const ev = (key: string, type: string) => ({ key, type, at: "2026-10-30T15:00:00Z", summary: `${type} summary` });

  it("writes each event once on the Keystone contact's timeline", async () => {
    db([[/SELECT id::text AS id FROM contacts/, { rows: [{ id: CONTACT }] }]]);
    const first = await send({ email: "Jo@Acme.example", events: [ev("sent:1", "email_sent"), ev("open:1", "email_opened")] });
    expect(first.body).toMatchObject({ ok: true, contact_id: CONTACT, created: false, added: 2 });
    const again = await send({ email: "jo@acme.example", events: [ev("sent:1", "email_sent")] });
    expect(again.body.added).toBe(0);
    const notes = callsMatching(h.query, /INSERT INTO crm_notes/);
    expect(notes).toHaveLength(2);
    expect((notes[0]![1] as unknown[])[0]).toBe("Keystone marketing: email_sent summary");
    expect(notes.every((c) => /'KS'/.test(String(c[0])))).toBe(true);
    expect(callsMatching(h.query, /marketing_opt_out = true/)).toHaveLength(0);
  });

  it("creates the Keystone contact as a lead when there is none", async () => {
    db([[/INSERT INTO contacts/, { rows: [{ id: CONTACT }] }]]);
    const r = await send({ email: "new@prospect.example", contact: { name: "Nia New", company: "New Co" }, events: [ev("sent:9", "email_sent")] });
    expect(r.body).toMatchObject({ created: true, added: 1 });
    const ins = callsMatching(h.query, /INSERT INTO contacts/)[0] as [string, unknown[]];
    expect(ins[1]).toEqual(expect.arrayContaining(["Nia", "New", "new@prospect.example", "KS"]));
    expect(callsMatching(h.query, /ks_stage = coalesce\(ks_stage, 'lead'\)/)).toHaveLength(1);
  });

  it("an unsubscribe sets the contact's marketing opt-out", async () => {
    db([[/SELECT id::text AS id FROM contacts/, { rows: [{ id: CONTACT }] }]]);
    await send({ email: "jo@acme.example", events: [ev("unsub:1", "unsubscribed")] });
    const upd = callsMatching(h.query, /marketing_opt_out = true/);
    expect(upd).toHaveLength(1);
    expect(String(upd[0]![0])).toMatch(/silo = 'KS'/);
  });

  it("rejects unknown event types and bad emails", async () => {
    const r = await send({ email: "nope", events: [ev("x", "payment")] });
    expect(r.status).toBe(400);
    expect(r.body.errors).toHaveProperty("email");
    expect(r.body.errors).toHaveProperty("events.0.type");
  });
});

describe("BF-Server's SendGrid webhook", () => {
  it("leaves Keystone marketing events to KS-Ops and still handles Boreal's", async () => {
    const { generateKeyPairSync, sign } = await import("node:crypto");
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    db([[/FROM contacts\s+WHERE lower\(trim\(coalesce\(email/, { rows: [{ id: CONTACT }] }]]);
    const events = [
      { event: "unsubscribe", email: "shared@both.example", ks_mkt: "1", ks_mkt_send_id: "42" },
      { event: "open", email: "bf@boreal.example" },
    ];
    const body = JSON.stringify(events);
    const ts = "1700000000";
    const sig = sign("sha256", Buffer.from(ts + body), privateKey).toString("base64");
    const hook = mountRouter((await import("../sendgridWebhook.js")).default, "/api/webhooks/sendgrid");
    const r = await request(hook).post("/api/webhooks/sendgrid").set("Content-Type", "application/json")
      .set("X-Twilio-Email-Event-Webhook-Signature", sig).set("X-Twilio-Email-Event-Webhook-Timestamp", ts).send(body);
    delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
    expect(r.status).toBe(200);
    const lookups = callsMatching(h.query, /FROM contacts\s+WHERE lower\(trim\(coalesce\(email/);
    expect(lookups.map((c) => (c[1] as unknown[])[0])).toEqual(["bf@boreal.example"]);
    expect(callsMatching(h.query, /marketing_opt_out = true/)).toHaveLength(0);
  });
});
