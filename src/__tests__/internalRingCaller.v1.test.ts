// BF_SERVER_INTERNAL_RING_CALLER_v1
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { mountRouter, staffToken } from "./helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  dial: vi.fn(),
  publishToUser: vi.fn(),
  publishToUsers: vi.fn(),
  publishBroadcast: vi.fn(),
}));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query }));
vi.mock("../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});
// Real conference service, except the Twilio dial-out.
vi.mock("../voice/conferenceService.js", async () => ({
  ...(await vi.importActual<any>("../voice/conferenceService.js")),
  dialClientIntoConference: h.dial,
}));
vi.mock("../voice/sseBus.js", async () => ({
  ...(await vi.importActual<any>("../voice/sseBus.js")),
  publishToUser: h.publishToUser,
  publishToUsers: h.publishToUsers,
  publishBroadcast: h.publishBroadcast,
}));

const APP_ID = "a1a1a1a1-0000-4000-8000-000000000001";
const CONF = { id: "conf-uuid-1", friendly_name: "mp_friendly_1", direction: "client_miniportal" };

const voiceApp = async () => mountRouter((await import("../routes/voiceCalls.js")).default, "/api/voice");
const webhookApp = async () => mountRouter((await import("../routes/webhooks.js")).default, "/api/webhooks");
const resolve = async (body: Record<string, unknown>) =>
  request(await voiceApp()).post("/api/voice/resolve-caller").set("Authorization", `Bearer ${staffToken()}`).send(body);

const ringRules = (appRow: Record<string, unknown> | null) => answerBySql([
  [/FROM staff_presence/, { rows: [{ user_id: "u-staff", twilio_identity: "staff_u1" }] }],
  [/INSERT INTO conferences/, { rows: [CONF] }],
  [/INSERT INTO conference_participants/, (_s: string, p?: unknown[]) => ({ rows: [{ id: `p-${String(p?.[3])}` }] })],
  [/FROM applications a\s+LEFT JOIN contacts c/, { rows: appRow ? [appRow] : [] }],
  [/SELECT \* FROM conference_participants WHERE conference_id/, { rows: [{ id: "p-staff", kind: "staff", identity: "staff_u1" }] }],
  [/SELECT \* FROM conferences WHERE id = \$1/, { rows: [CONF] }],
]);

function incomingToast() {
  const call = h.publishToUsers.mock.calls.find((c) => c[1] === "conference.incoming");
  return call ? { staffIds: call[0], data: call[2] } : null;
}

beforeEach(() => {
  h.query.mockReset().mockImplementation(answerBySql([]));
  h.dial.mockReset().mockResolvedValue(undefined);
  h.publishToUser.mockReset();
  h.publishToUsers.mockReset();
  h.publishBroadcast.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("internal incoming-ring caller resolution", () => {
  it("resolves an internal caller from the live conference", async () => {
    h.query.mockImplementation(answerBySql([[/FROM conferences c/, { rows: [{ user_id: "u-9", first_name: "Ann", last_name: "Lee" }] }]]));
    const res = await resolve({ phone: "", conferenceFriendly: "int_friendly_9" });
    expect(res.body).toEqual({ ok: true, matched: true, isStaff: true, name: "Ann Lee", userId: "u-9" });
    const [call] = callsMatching(h.query, /FROM conferences c/);
    const sql = String(call[0]);
    expect(sql).toContain("JOIN conference_participants cp");
    expect(sql).toContain("cp.identity = c.created_by_user_id::text");
    expect(sql).toContain("c.direction = 'internal'");
    expect(call[1]).toEqual(["int_friendly_9"]);
  });

  it("keeps contact and staff phone lookups in independent error boundaries", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // The colleague-first check finds nobody, the contact lookup fails, and the
    // staff-directory fallback after it still answers.
    let usersLookups = 0;
    h.query.mockImplementation(answerBySql([
      [/FROM contacts c/, new Error("contacts down")],
      [/FROM users\s+WHERE active = true/, () => (++usersLookups === 1 ? { rows: [] } : { rows: [{ user_id: "u-2", first_name: "Bo", last_name: "Ng" }] })],
    ]));
    const res = await resolve({ phone: "+14035550199" });
    expect(res.body).toMatchObject({ matched: true, isStaff: true, name: "Bo Ng" });
    expect(error).toHaveBeenCalledWith("resolve_caller_contact_failed", { message: "contacts down" });

    // The staff fallback fails too: still a clean "no match", and both failures are logged.
    h.query.mockImplementation(answerBySql([[/FROM contacts c/, new Error("contacts down")], [/FROM users\s+WHERE active = true/, new Error("users down")]]));
    const none = await resolve({ phone: "+14035550199" });
    expect(none.body).toEqual({ ok: true, matched: false, isStaff: false, name: null });
    expect(error).toHaveBeenCalledWith("resolve_caller_staff_failed", { message: "users down" });
  });

  it("broadcasts a Call Us! ring by conference id with the caller's number and the joinable friendly name", async () => {
    h.query.mockImplementation(ringRules({ full_name: "Jean Client", business_name: "Toitures", phone: "(825) 451-1768" }));
    const res = await request(await webhookApp()).post("/api/webhooks/twilio/voice/twiml").type("form")
      .send({ From: `client:client-${APP_ID}`, To: "", CallSid: "CA0000000000000000000000000000mp01" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(incomingToast()).not.toBeNull());
    expect(incomingToast()).toEqual({
      staffIds: ["staff_u1"],
      data: { conferenceId: CONF.id, conferenceFriendly: CONF.friendly_name, fromDisplay: "+18254511768" },
    });
  });

  it("falls back to the client identity when the applicant has no usable number", async () => {
    h.query.mockImplementation(ringRules({ full_name: "Jean Client", business_name: null, phone: null }));
    await request(await webhookApp()).post("/api/webhooks/twilio/voice/twiml").type("form")
      .send({ From: `client:client-${APP_ID}`, CallSid: "CA0000000000000000000000000000mp02" });
    await vi.waitFor(() => expect(incomingToast()).not.toBeNull());
    expect(incomingToast()!.data.fromDisplay).toBe(`client:client-${APP_ID}`);
    expect(incomingToast()!.data.fromDisplay).not.toBe("Client mini-portal");
  });

  it("broadcasts a PSTN ring by conference id with the caller's number", async () => {
    h.query.mockImplementation(ringRules(null));
    await request(await webhookApp()).post("/api/webhooks/twilio/voice/twiml").type("form")
      .send({ From: "+14035550142", To: "+18666318939", CallSid: "CA0000000000000000000000000000ps01" });
    await vi.waitFor(() => expect(incomingToast()).not.toBeNull());
    expect(incomingToast()!.data).toEqual({ conferenceId: CONF.id, conferenceFriendly: CONF.friendly_name, fromDisplay: "+14035550142" });
  });

  it("falls back to the conference id when the conference has no friendly name", async () => {
    const { broadcastIncomingRing } = await import("../voice/conferenceService.js");
    h.query.mockImplementation(answerBySql([[/SELECT \* FROM conferences WHERE id = \$1/, { rows: [] }]]));
    await broadcastIncomingRing("conf-raw", "+14035550100");
    expect(h.publishBroadcast).toHaveBeenCalledWith("conference.incoming", { conferenceId: "conf-raw", conferenceFriendly: "conf-raw", fromDisplay: "+14035550100" });
  });
});
