// BF_SERVER_BLOCK_v499_STAFF_SMS_DELIVERY_STATUS
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock, createMock } = vi.hoisted(() => ({ queryMock: vi.fn(), createMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock };
});
vi.mock("../lib/sharedClients.js", () => ({
  sharedTwilio: () => ({ messages: { create: createMock } }),
  sharedOpenAI: () => ({}),
}));

const STAFF_ID = "00000000-0000-4000-8000-0000000000a1";
const CONTACT = "11111111-2222-4333-8444-555555555555";
const APP_ID = "22222222-3333-4444-8555-666666666666";
const TO = "+15874441234";
const token = () => jwt.sign({ sub: STAFF_ID, id: STAFF_ID, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

async function app() {
  const router = (await import("../routes/communications.js")).default;
  const a = express();
  a.use(express.json());
  a.use("/api/communications", router);
  return a;
}

beforeEach(() => {
  queryMock.mockReset();
  createMock.mockReset();
  createMock.mockResolvedValue({ sid: "SM42", status: "queued" });
  process.env.TWILIO_FROM_NUMBER = "+15875550100";
  process.env.PUBLIC_BASE_URL = "https://api.example.test/";
  queryMock.mockImplementation(answerBySql([
    [/FROM communications_messages[\s\S]*type = 'sms'/, {
      rows: [{ id: "m1", direction: "outbound", body: "hi", delivery_status: "undelivered", delivery_error: "30007" }],
    }],
  ]));
});
afterEach(() => { delete process.env.TWILIO_FROM_NUMBER; delete process.env.PUBLIC_BASE_URL; });

describe("v499 staff SMS delivery status", () => {
  it("asks Twilio for delivery updates and records the send", async () => {
    const res = await request(await app()).post("/api/communications/sms").set("Authorization", `Bearer ${token()}`)
      .send({ to: TO, body: "hello", applicationId: APP_ID });
    expect(res.status).toBe(200);
    const payload = createMock.mock.calls[0]![0];
    expect(payload.to).toBe(TO);
    expect(payload.statusCallback).toBe("https://api.example.test/api/r/status");
    const [rec] = callsMatching(queryMock, "INSERT INTO sms_deliveries");
    expect(rec![0]).toMatch(/'staff_sms'/);
    expect(rec![0]).toMatch(/ON CONFLICT \(message_sid\) DO NOTHING/);
    expect(rec![1]).toEqual(["SM42", TO, APP_ID, "queued"]);
  });

  it("a failed delivery record is logged, not fatal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    queryMock.mockImplementation(answerBySql([[/INSERT INTO sms_deliveries/, new Error("relation missing")]]));
    const res = await request(await app()).post("/api/communications/sms").set("Authorization", `Bearer ${token()}`).send({ to: TO, body: "hello" });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith("[sms] delivery record failed", expect.objectContaining({ sid: "SM42" }));
    warn.mockRestore();
  });

  it("the thread returns delivery status and error code", async () => {
    const res = await request(await app()).get(`/api/communications/sms/thread?contactId=${CONTACT}`).set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.messages[0]).toMatchObject({ delivery_status: "undelivered", delivery_error: "30007" });
    const [q] = callsMatching(queryMock, /type = 'sms'/);
    expect(q![0]).toMatch(/FROM sms_deliveries d WHERE d\.message_sid = communications_messages\.twilio_sid[\s\S]*AS delivery_status/);
    expect(q![0]).toMatch(/d\.error_code[\s\S]*AS delivery_error/);
  });
});
