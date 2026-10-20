// BF_SERVER_v821_DIALER - the caller card: GET /api/voice/caller-card and the same facts as Twilio <Client>
// custom parameters on inbound calls that ring the app (direct lines, named reception targets, engagement group).
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { mountRouter, staffToken } from "./helpers/staffRouterApp.js";

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

import { callerCardFor, clientParameters, stageLabel, CALLER_CARD_SQL } from "../voice/callerCard.js";

const CONTACT = "c0c0c0c0-0000-4000-8000-000000000002";
const APP = "a0a0a0a0-0000-4000-8000-000000000003";
const OWNER = "44444444-4444-4444-8444-444444444444";
const CALLER = "+14035550142";
const CARD_SQL = /FROM contacts c\s+LEFT JOIN companies co/;
const cardRow = (row: Record<string, unknown> = {}) => ({
  contact_id: CONTACT, name: "Jane Client", company: "Client Trucking Ltd", tags: ["vip", "equipment"],
  application_id: APP, pipeline_state: "In Review", business_name: "Client Trucking Ltd",
  last_note: "Spoke about the equipment quote. ".repeat(10), last_contact_at: "2026-10-16T15:00:00.000Z", ...row,
});

beforeEach(() => { h.query.mockReset(); h.query.mockImplementation(answerBySql([])); vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe("callerCardFor", () => {
  it("maps the CRM contact, its latest application stage, the last note (<=140) and tags", async () => {
    h.query.mockImplementation(answerBySql([[CARD_SQL, { rows: [cardRow()] }]]));
    const card = await callerCardFor({ query: h.query } as any, "(403) 555-0142", "BF");
    expect(card).toMatchObject({
      found: true, contactId: CONTACT, name: "Jane Client", company: "Client Trucking Ltd", stage: "In Review",
      applicationId: APP, lastContactAt: "2026-10-16T15:00:00.000Z", tags: ["vip", "equipment"],
    });
    expect(card.lastNote!.length).toBe(140);
    expect(card.lastNote!.endsWith("…")).toBe(true);
    expect(callsMatching(h.query, CARD_SQL)[0]![1]).toEqual(["4035550142", "BF"]);
  });

  it("not found / not a phone number", async () => {
    expect(await callerCardFor({ query: h.query } as any, CALLER, "BF")).toEqual({ found: false });
    expect(await callerCardFor({ query: h.query } as any, "client:abc", "BF")).toEqual({ found: false });
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it("an 'Unknown caller' placeholder contact has no name; no application means no stage", async () => {
    h.query.mockImplementation(answerBySql([[CARD_SQL, { rows: [cardRow({ name: "Unknown caller", company: null, business_name: null, application_id: null, pipeline_state: null, last_note: null, last_contact_at: null, tags: null })] }]]));
    expect(await callerCardFor({ query: h.query } as any, CALLER, null)).toEqual({ found: true, contactId: CONTACT, tags: [] });
  });

  it("stage is the portal's label; legacy lower-case states are title-cased", () => {
    expect(stageLabel("Off to Lender")).toBe("Off to Lender");
    expect(stageLabel("draft")).toBe("Draft");
    expect(stageLabel("")).toBeUndefined();
  });

  it("read-only, merged contacts excluded, silo-filtered", () => {
    expect(CALLER_CARD_SQL).not.toMatch(/INSERT|UPDATE/);
    expect(CALLER_CARD_SQL).toContain("c.merged_into_id IS NULL");
    expect(CALLER_CARD_SQL).toContain("($2::text IS NULL OR c.silo = $2)");
  });
});

describe("GET /api/voice/caller-card", () => {
  const app = async () => mountRouter((await import("../routes/voiceCalls.js")).default, "/api/voice");

  it("returns the card for the request's silo (X-Silo, under the usual silo rules)", async () => {
    h.query.mockImplementation(answerBySql([[CARD_SQL, { rows: [cardRow({ last_note: "Wants a callback" })] }]]));
    const res = await request(await app()).get("/api/voice/caller-card").query({ phone: CALLER })
      .set("Authorization", `Bearer ${staffToken("Admin")}`).set("X-Silo", "BI");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      found: true, contactId: CONTACT, name: "Jane Client", company: "Client Trucking Ltd", stage: "In Review", applicationId: APP,
      lastNote: "Wants a callback", lastContactAt: "2026-10-16T15:00:00.000Z", tags: ["vip", "equipment"],
    });
    expect((callsMatching(h.query, CARD_SQL)[0]![1] as unknown[])[1]).toBe("BI");
  });

  it("found:false for an unknown number, 400 for a bad one, 401 without a sign-in", async () => {
    const auth = { Authorization: `Bearer ${staffToken("Staff")}` };
    expect((await request(await app()).get("/api/voice/caller-card").query({ phone: CALLER }).set(auth)).body).toEqual({ found: false });
    expect((await request(await app()).get("/api/voice/caller-card").query({ phone: "12" }).set(auth)).status).toBe(400);
    expect((await request(await app()).get("/api/voice/caller-card").query({ phone: CALLER })).status).toBe(401);
  });
});

describe("<Client> custom parameters on inbound calls", () => {
  it("clientParameters: only the fields that have a value, clipped", () => {
    expect(clientParameters(null)).toEqual([]);
    expect(clientParameters({ found: true, contactId: CONTACT, name: "Jane Client", stage: "Offer" })).toEqual([
      { name: "callerName", value: "Jane Client" }, { name: "callerStage", value: "Offer" }, { name: "contactId", value: CONTACT },
    ]);
  });

  async function directLine(rules: Array<[RegExp, unknown]>) {
    h.query.mockImplementation(answerBySql([
      [/WHERE u\.direct_number = \$1/, { rows: [{ user_id: OWNER, first_name: "Pat", last_name: "Staff", twilio_identity: OWNER }] }],
      ...rules,
    ]));
    const app = mountRouter((await import("../routes/webhooks.js")).default, "/api/webhooks");
    const res = await request(app).post("/api/webhooks/twilio/voice/twiml").type("form").send({ From: CALLER, To: "+18255550190", CallSid: "CA-card-1" });
    expect(res.status).toBe(200);
    return res.text;
  }

  it("direct line: <Client><Identity> + callerName / callerCompany / callerStage / contactId", async () => {
    const xml = await directLine([[CARD_SQL, { rows: [cardRow()] }]]);
    expect(xml).toContain(`<Identity>${OWNER}</Identity>`);
    expect(xml).toContain('<Parameter name="callerName" value="Jane Client"/>');
    expect(xml).toContain('<Parameter name="callerCompany" value="Client Trucking Ltd"/>');
    expect(xml).toContain('<Parameter name="callerStage" value="In Review"/>');
    expect(xml).toContain(`<Parameter name="contactId" value="${CONTACT}"/>`);
  });

  it("no matching contact: the plain <Client>identity</Client>", async () => {
    const xml = await directLine([]);
    expect(xml).toMatch(new RegExp(`<Client[^>]*>${OWNER}</Client>`));
    expect(xml).not.toContain("<Parameter");
  });

  it("a failing card lookup never stops the call", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const xml = await directLine([[CARD_SQL, new Error("db down")]]);
    expect(xml).toMatch(new RegExp(`<Client[^>]*>${OWNER}</Client>`));
  });

  it("reception engagement group: every member's <Client> carries the card", async () => {
    h.query.mockImplementation(answerBySql([
      [CARD_SQL, { rows: [cardRow()] }],
      [/FROM users u JOIN staff_presence sp ON sp\.user_id = u\.id\s+WHERE \(u\.first_name ILIKE \$1/, (_sql: string, params?: unknown[]) => ({
        rows: String(params?.[0]).includes("todd")
          ? [{ status: "available", twilio_identity: "todd-client", on_call: false, fresh: true, ringable: true, phone: null, standalone_watch: false, user_id: OWNER }]
          : [],
      })],
      [/SELECT DISTINCT sp\.twilio_identity/, { rows: [{ twilio_identity: "staff-2" }] }],
    ]));
    const app = mountRouter((await import("../routes/reception.js")).default, "/api/webhooks/twilio/reception");
    const res = await request(app).post("/api/webhooks/twilio/reception/intent?company=BF").type("form").send({ Digits: "1", From: CALLER, CallSid: "CA-card-2" });
    expect(res.text).toContain("<Identity>todd-client</Identity>");
    expect(res.text).toContain("<Identity>staff-2</Identity>");
    expect(res.text.match(/<Parameter name="callerName" value="Jane Client"\/>/g)).toHaveLength(2);
  });
});
