// BF_SERVER_CLIENT_CALL_CALLER_ID_v326
import request from "supertest";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { mountRouter, staffToken } from "../../__tests__/helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn(), dial: vi.fn(), publishToUsers: vi.fn(), publishBroadcast: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: h.query }, dbQuery: h.query }));
vi.mock("../../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});
vi.mock("../../voice/conferenceService.js", async () => ({
  ...(await vi.importActual<any>("../../voice/conferenceService.js")),
  dialClientIntoConference: h.dial,
}));
vi.mock("../../voice/sseBus.js", async () => ({
  ...(await vi.importActual<any>("../../voice/sseBus.js")),
  publishToUsers: h.publishToUsers,
  publishBroadcast: h.publishBroadcast,
}));

const APP_ID = "b2b2b2b2-0000-4000-8000-000000000326";
const CONF = { id: "conf-326", friendly_name: "mp_326" };
const FROM = `client:client-${APP_ID}`;

function rules(appRow: Record<string, unknown> | null) {
  return answerBySql([
    [/FROM staff_presence/, { rows: [{ user_id: "u-1", twilio_identity: "staff_u1" }] }],
    [/INSERT INTO conferences/, { rows: [CONF] }],
    [/INSERT INTO conference_participants/, { rows: [{ id: "p-1" }] }],
    [/FROM applications a\s+LEFT JOIN contacts c ON c\.id = a\.contact_id/, { rows: appRow ? [appRow] : [] }],
    [/SELECT \* FROM conference_participants WHERE conference_id/, { rows: [{ id: "p-1", kind: "staff", identity: "staff_u1" }] }],
    [/SELECT \* FROM conferences WHERE id = \$1/, { rows: [CONF] }],
  ]);
}
async function ring(appRow: Record<string, unknown> | null) {
  h.query.mockImplementation(rules(appRow));
  const app = mountRouter((await import("../webhooks.js")).default, "/api/webhooks");
  return request(app).post("/api/webhooks/twilio/voice/twiml").type("form").send({ From: FROM, CallSid: "CA00000000000000000000000000000326" });
}
const ringFrom = () => h.publishToUsers.mock.calls.find((c) => c[1] === "conference.incoming")?.[2]?.fromDisplay;

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.query.mockReset();
  h.dial.mockReset().mockResolvedValue(undefined);
  h.publishToUsers.mockReset();
  h.publishBroadcast.mockReset();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a Call Us! caller reaches staff with a name", () => {
  it("rings staff from the applicant's own number", async () => {
    const res = await ring({ full_name: "Jean Client", business_name: "Toitures", phone: "(825) 451-1768" });
    expect(res.status).toBe(200);
    expect(h.dial).toHaveBeenCalledWith(expect.objectContaining({ identity: "staff_u1", fromNumber: "+18254511768" }));
  });

  it("resolves the applicant through the application and broadcasts a resolvable caller", async () => {
    await ring({ full_name: "Jean Client", business_name: "Toitures", phone: "8254511768" });
    const [lookup] = callsMatching(h.query, /FROM applications a\s+LEFT JOIN contacts c ON c\.id = a\.contact_id/);
    expect(lookup[1]).toEqual([APP_ID]);
    await vi.waitFor(() => expect(ringFrom()).toBe("+18254511768"));

    // No usable number: the client identity, never a dead "Client mini-portal" label.
    h.publishToUsers.mockReset();
    await ring({ full_name: "Jean Client", business_name: null, phone: null });
    await vi.waitFor(() => expect(ringFrom()).toBe(FROM));
  });

  it("the staff app resolves the same caller (BF_SERVER_CLIENT_APP_CALLER_v1), carrying the business name", async () => {
    h.query.mockImplementation(answerBySql([[/FROM applications a\s+LEFT JOIN contacts c/, {
      rows: [{ contact_id: "c-1", full_name: "Jean Client", phone: "+18254511768", application_id: APP_ID, business_name: " Toitures Tremblay " }],
    }]]));
    const app = mountRouter((await import("../voiceCalls.js")).default, "/api/voice");
    const res = await request(app).post("/api/voice/resolve-caller").set("Authorization", `Bearer ${staffToken()}`).send({ phone: FROM });
    expect(res.body).toEqual({
      ok: true, matched: true, isStaff: false, name: "Jean Client", contactId: "c-1",
      applicationId: APP_ID, companyName: "Toitures Tremblay", phone: "+18254511768",
    });
  });

  it("logs resolution", async () => {
    await ring({ full_name: "Jean Client", business_name: "Toitures", phone: "8254511768" });
    const line = log.mock.calls.map((c) => String(c[0])).find((s) => s.includes("client_miniportal_caller_resolved"));
    expect(JSON.parse(String(line))).toMatchObject({ event: "client_miniportal_caller_resolved", applicationId: APP_ID, hasPhone: true });
  });
});

describe("an unusable number is never sent to Twilio", () => {
  it.each([
    ["(825) 451-1768", "+18254511768"],
    ["8254511768", "+18254511768"],
    ["+1 825 451 1768", "+18254511768"],
    ["", ""],
    [null, ""],
    ["not a phone", ""],
    ["12345", ""],
  ])("%s -> %s", async (input, expected) => {
    await ring({ full_name: "Jean Client", business_name: null, phone: input });
    expect(h.dial).toHaveBeenCalledWith(expect.objectContaining({ fromNumber: expected }));
  });
});
