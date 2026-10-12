// BF_SERVER_BLOCK_v589_APP_FIRST
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { pushToClientApp, type ClientNotice, type NotifyDeps } from "../notifyClient.js";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const { queryMock, appPush, sendSmsMock, sendSMSMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  appPush: { mock: null as null | ReturnType<typeof vi.fn> },
  sendSmsMock: vi.fn(),
  sendSMSMock: vi.fn(),
}));
// The real pushToClientApp is tested directly below; the senders get a switchable stand-in.
let appTakesIt = false;
vi.mock("../notifyClient.js", async () => {
  const actual = await vi.importActual<typeof import("../notifyClient.js")>("../notifyClient.js");
  const routed = vi.fn(async (n: ClientNotice, deps?: NotifyDeps) => (deps ? actual.pushToClientApp(n, deps) : appTakesIt));
  appPush.mock = routed;
  return { ...actual, pushToClientApp: routed };
});
vi.mock("../../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db.js");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});
vi.mock("../../../modules/notifications/sms.service.js", () => ({ sendSms: sendSmsMock }));
vi.mock("../../smsService.js", () => ({ sendSMS: sendSMSMock }));
vi.mock("../../../workers/claim.js", () => ({ claimedTick: (_name: string, fn: () => Promise<void>) => fn }));

const n: ClientNotice = { phone: "+1 (587) 555-0100", applicationId: "a1", kind: "staff_message", sms: "", title: "t", body: "b" };
const deps = (over: Partial<NotifyDeps>): NotifyDeps => ({
  pushReady: async () => true, pushUsersForPhone: async () => ["client:+15875550100"], push: async () => 1,
  sms: vi.fn(async () => undefined), record: vi.fn(async () => undefined), ...over,
});

beforeEach(() => {
  appTakesIt = false;
  queryMock.mockReset();
  sendSmsMock.mockReset();
  sendSmsMock.mockResolvedValue({ sid: "SM1" });
  sendSMSMock.mockReset();
  sendSMSMock.mockResolvedValue(undefined);
});

describe("pushToClientApp", () => {
  it("returns true and records push when the app takes it; never texts", async () => {
    const d = deps({});
    expect(await pushToClientApp(n, d)).toBe(true);
    expect(d.sms).not.toHaveBeenCalled();
    expect(d.record).toHaveBeenCalledWith(n, "5875550100", { channel: "push" });
  });
  it("returns false (caller texts) with no app, push not configured, or a failed push", async () => {
    expect(await pushToClientApp(n, deps({ pushUsersForPhone: async () => [] }))).toBe(false);
    expect(await pushToClientApp(n, deps({ pushReady: async () => false }))).toBe(false);
    expect(await pushToClientApp(n, deps({ push: async () => { throw new Error("apns"); } }))).toBe(false);
    expect(await pushToClientApp({ ...n, phone: "123" }, deps({}))).toBe(false);
  });
});

describe("staff messages try the app before SMS", () => {
  const STAFF_ID = "00000000-0000-4000-8000-0000000000a1";
  const CONTACT = "11111111-2222-4333-8444-555555555555";
  async function sendStaffMessage() {
    queryMock.mockImplementation(answerBySql([
      [/MAX\(a\.last_portal_seen_at\)/, { rows: [{ last_seen: null, phone: "+15874441234", seconds_since: null }] }],
    ]));
    const router = (await import("../../../routes/communications.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/communications", router);
    const tok = jwt.sign({ sub: STAFF_ID, id: STAFF_ID, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
    const res = await request(app).post("/api/communications/messages/send").set("Authorization", `Bearer ${tok}`).send({ contactId: CONTACT, body: "Your docs are ready" });
    expect(res.status).toBe(201);
    expect(callsMatching(queryMock, /MAX\(a\.last_portal_seen_at\)/)).toHaveLength(1);
  }

  it("client away and the app takes it: no text", async () => {
    appTakesIt = true;
    await sendStaffMessage();
    expect(appPush.mock).toHaveBeenCalledWith(expect.objectContaining({ phone: "+15874441234", kind: "staff_message" }));
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("client away and no app: falls back to SMS with a link", async () => {
    await sendStaffMessage();
    expect(appPush.mock).toHaveBeenCalled();
    await vi.waitFor(() => expect(sendSmsMock).toHaveBeenCalledTimes(1));
    expect(sendSmsMock.mock.calls[0]![0]).toMatchObject({ to: "+15874441234" });
    expect(sendSmsMock.mock.calls[0]![0].message).toContain("Boreal: Your docs are ready");
  });
});

describe("abandoned-application reminders try the app before SMS", () => {
  async function tick() {
    const pool = {
      query: vi.fn(answerBySql([
        [/AND a\.abandon_sms_sent_at IS NULL/, { rows: [{ id: "app-1", contact_id: "c-1", phone: "+15874441234", silo: "BF" }] }],
      ])),
    };
    const { startAbandonedApplicationWorker, ABANDON_SMS_BODY } = await import("../../../workers/abandonedApplicationWorker.js");
    const w = startAbandonedApplicationWorker(pool as any);
    await vi.waitFor(() => expect(callsMatching(pool.query, /SET abandon_sms_sent_at = now\(\)/).length).toBeGreaterThan(0));
    w.stop();
    return { pool, ABANDON_SMS_BODY };
  }

  it("the app takes it: no text, still stamped as sent", async () => {
    appTakesIt = true;
    await tick();
    expect(appPush.mock).toHaveBeenCalledWith(expect.objectContaining({ kind: "abandoned_application", phone: "+15874441234" }));
    expect(sendSMSMock).not.toHaveBeenCalled();
  });

  it("no app: the reminder is texted", async () => {
    const { ABANDON_SMS_BODY } = await tick();
    expect(sendSMSMock).toHaveBeenCalledWith("+15874441234", ABANDON_SMS_BODY);
  });
});
