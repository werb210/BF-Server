// BF_SERVER_RCS_SENDER_v770
import { describe, it, expect, afterEach, vi } from "vitest";
import { smsSenderFor } from "../lib/smsFrom.js";
import { BULK, TRANSACTIONAL, driveSender } from "./helpers/smsSenderDrivers.js";

const { queryMock, createMock } = vi.hoisted(() => ({ queryMock: vi.fn(), createMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});
vi.mock("../lib/sharedClients.js", () => ({ sharedTwilio: () => ({ messages: { create: createMock } }), sharedOpenAI: () => ({}) }));
vi.mock("../services/twilio.js", () => ({ fetchTwilioClient: () => ({ messages: { create: createMock } }) }));
vi.mock("twilio", () => ({ default: () => ({ messages: { create: createMock } }) }));
vi.mock("../services/push/applicantPush.js", () => ({ notifyApplicant: vi.fn(async () => undefined) }));
vi.mock("../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn(async () => undefined) }));
vi.mock("../services/lenderMatchCache.js", () => ({
  markLenderMatchesStale: vi.fn(async () => undefined),
  computeAndCacheLenderMatches: vi.fn(async () => undefined),
  getOutstandingRequiredDocs: vi.fn(async () => []),
}));

const SID = "MG" + "a".repeat(32);
afterEach(() => { delete process.env.TWILIO_RCS_MESSAGING_SERVICE_SID; delete process.env.TWILIO_US_SMS_FROM; });

describe("branded (RCS) texting through a Messaging Service", () => {
  it("unchanged when no Messaging Service is configured: the local number for Canada and the US (v813)", () => {
    expect(smsSenderFor("+15875550123", "+15875550100")).toEqual({ from: "+15875550100" });
    expect(smsSenderFor("+19173043342", "+15875550100")).toEqual({ from: "+15875550100" });
  });
  it("sends through the Messaging Service when TWILIO_RCS_MESSAGING_SERVICE_SID is a valid MG sid", () => {
    process.env.TWILIO_RCS_MESSAGING_SERVICE_SID = SID;
    expect(smsSenderFor("+15875550123", "+15875550100")).toEqual({ messagingServiceSid: SID });
    expect(smsSenderFor("+19173043342", "+15875550100")).toEqual({ messagingServiceSid: SID });
  });
  it("ignores a malformed value instead of breaking texting", () => {
    process.env.TWILIO_RCS_MESSAGING_SERVICE_SID = "not-a-sid";
    expect(smsSenderFor("+15875550123", "+15875550100")).toEqual({ from: "+15875550100" });
  });

  it.each(TRANSACTIONAL)("%s (transactional) sends through the Messaging Service", async (name) => {
    process.env.TWILIO_RCS_MESSAGING_SERVICE_SID = SID;
    const r = await driveSender(name, "+15874441234", { queryMock, createMock });
    expect(r.error).toBeUndefined();
    expect(r.payload, `${name} reached Twilio`).toBeDefined();
    expect(r.payload!.messagingServiceSid).toBe(SID);
    expect(r.payload).not.toHaveProperty("from");
  });

  it.each(BULK)("%s (marketing / bulk) does not", async (name) => {
    process.env.TWILIO_RCS_MESSAGING_SERVICE_SID = SID;
    const r = await driveSender(name, "+15874441234", { queryMock, createMock });
    expect(r.payload, `${name} reached Twilio`).toBeDefined();
    expect(r.payload).not.toHaveProperty("messagingServiceSid");
    expect(r.payload!.from).toBeTruthy();
  });

  it("staff texts from the BI silo stay plain SMS (BF_SERVER_RCS_BRAND_BF_ONLY_v781)", async () => {
    process.env.TWILIO_RCS_MESSAGING_SERVICE_SID = SID;
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const jwt = (await import("jsonwebtoken")).default;
    const router = (await import("../routes/communications.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/communications", router);
    const id = "00000000-0000-4000-8000-0000000000a1";
    const tok = jwt.sign({ sub: id, id, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
    createMock.mockReset();
    createMock.mockResolvedValue({ sid: "SM1", status: "queued" });
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    process.env.TWILIO_FROM_NUMBER = "+15875550100";
    const res = await request(app).post("/api/communications/sms").set("Authorization", `Bearer ${tok}`).set("X-Silo", "BI")
      .send({ to: "+15874441234", body: "hello" });
    delete process.env.TWILIO_FROM_NUMBER;
    expect(res.status).toBe(200);
    expect(createMock.mock.calls[0]![0]).toMatchObject({ from: "+15875550100" });
    expect(createMock.mock.calls[0]![0]).not.toHaveProperty("messagingServiceSid");
  });
});
