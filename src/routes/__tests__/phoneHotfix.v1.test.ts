// BF_SERVER_PHONE_HOTFIX_v1
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";
import { answerBySql, callsMatching, sqlText } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  callLogStaff: "u-from-call-log" as string | null,
  enrich: vi.fn(async () => undefined),
}));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));
vi.mock("../../modules/calls/calls.repo.js", async (orig) => ({
  ...(await orig<typeof import("../../modules/calls/calls.repo.js")>()),
  findCallLogByTwilioSid: vi.fn(async () => (h.callLogStaff ? { staff_user_id: h.callLogStaff } : null)),
}));
vi.mock("../../modules/voice/voicemailEnrich.service.js", () => ({ enrichAndDistributeVoicemail: h.enrich }));

const TODD = "11111111-1111-4111-8111-111111111111";
const ANDREW = "22222222-2222-4222-8222-222222222222";

// Twilio signs every webhook; requests here are signed with the real library.
async function signedPost(mount: string, modPath: string, path: string, params: Record<string, string>) {
  const router = (await import(modPath)).default;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(mount, router);
  const full = mount + path;
  return request(app).post(full).type("form").set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https")
    .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(String(process.env.TWILIO_AUTH_TOKEN), "https://example.com" + full, params))
    .send(params);
}

// Who is behind each reception target, as resolveTarget reads them.
function staff(over: { andrew?: Record<string, unknown> } = {}) {
  h.query.mockImplementation(answerBySql([
    [/FROM users u JOIN staff_presence sp ON sp\.user_id = u\.id\s+WHERE \(u\.first_name ILIKE \$1/, (_sql: string, p?: unknown[]) => ({
      rows: [p?.[0] === "andrew" // BF_SERVER_v831_DIALER_POLISH - exact first name now
        ? { status: "available", twilio_identity: "andrew-client", on_call: false, fresh: true, phone: null, standalone_watch: false, user_id: ANDREW, ...over.andrew }
        : { status: "available", twilio_identity: "todd-client", on_call: false, fresh: true, phone: null, standalone_watch: false, user_id: TODD }],
    })],
  ]));
}

beforeEach(() => { h.query.mockReset(); h.callLogStaff = "u-from-call-log"; h.enrich.mockClear(); });

describe("phone hotfix", () => {
  it("voicemail list shows directed AND general (null-owner) voicemails", async () => {
    h.query.mockImplementation(answerBySql([[/FROM voicemails v/, { rows: [{ id: "vm-1" }, { id: "vm-2" }] }]]));
    const router = (await import("../crm/voicemails.js")).default;
    const app = express();
    app.use((req: any, _res, next) => { req.user = { userId: TODD, role: "Staff", silo: "BF" }; next(); });
    app.use("/api/crm/voicemails", router);
    const res = await request(app).get("/api/crm/voicemails");
    expect(res.status).toBe(200);
    const [sql, params] = callsMatching(h.query, /FROM voicemails v/)[0]!;
    expect(sqlText(sql)).toContain("v.staff_user_id = $2 OR v.staff_user_id IS NULL");
    expect(params).toEqual(["BF", TODD]);
  });

  it("reception forwards the real caller id, not the business line", async () => {
    staff();
    const withCaller = await signedPost("/api/webhooks/twilio/reception", "../reception.js", "/intent?company=BF", { Digits: "2", From: "+15875550142" });
    expect(withCaller.status).toBe(200);
    expect(withCaller.text).toContain('callerId="+15875550142"');
    expect(withCaller.text).toContain("<Client>andrew-client</Client>");

    const anonymous = await signedPost("/api/webhooks/twilio/reception", "../reception.js", "/intent?company=BF", { Digits: "2" });
    const { config } = await import("../../config/index.js");
    const fallback = config.twilio.callerId || config.twilio.from || config.twilio.number;
    if (fallback) expect(anonymous.text).toContain(`callerId="${fallback}"`);
    else expect(anonymous.text).not.toContain("callerId=");
  });

  it("reception stamps the voicemail with the resolved target staff", async () => {
    staff({ andrew: { status: "offline", fresh: false } });
    const res = await signedPost("/api/webhooks/twilio/reception", "../reception.js", "/intent?company=BF", { Digits: "2", From: "+15875550142" });
    expect(res.text).toContain("Sorry, Andrew isn't available right now.");
    expect(res.text).toContain(`action="/api/webhooks/twilio/voicemail?staff=${ANDREW}"`);

    // No answer after ringing: the voicemail still goes to the person asked for.
    staff();
    const noAnswer = await signedPost("/api/webhooks/twilio/reception", "../reception.js", "/unavailable?target=underwriting", { DialCallStatus: "no-answer" });
    expect(noAnswer.text).toContain(`action="/api/webhooks/twilio/voicemail?staff=${ANDREW}"`);
  });

  it("voicemail webhook prefers the ?staff hint over the call_log lookup", async () => {
    h.query.mockImplementation(answerBySql([]));
    const params = { RecordingUrl: "https://api.twilio.com/rec/RE1", RecordingSid: "RE1", CallSid: "CA1", From: "+15875550142", RecordingDuration: "12" };
    const hinted = await signedPost("/api/webhooks", "../webhooks.js", `/twilio/voicemail?staff=${ANDREW}`, params);
    expect(hinted.status).toBe(200);
    expect((callsMatching(h.query, /INSERT INTO voicemails/)[0]![1] as unknown[])[5]).toBe(ANDREW);
    expect((h.enrich.mock.calls[0] as unknown as [any])[0].staffUserId).toBe(ANDREW);

    h.query.mockClear(); h.enrich.mockClear();
    await signedPost("/api/webhooks", "../webhooks.js", "/twilio/voicemail", params);
    expect((callsMatching(h.query, /INSERT INTO voicemails/)[0]![1] as unknown[])[5]).toBe("u-from-call-log");
  });
});
