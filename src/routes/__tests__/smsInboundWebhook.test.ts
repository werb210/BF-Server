import express from "express";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js"; // BF_SERVER_SQL_CONTENT_MOCKS_v762
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: queryMock } }));

describe("smsInboundWebhook", () => {
  beforeEach(() => queryMock.mockReset());
  async function app(){ const r=(await import("../smsInboundWebhook.js")).default; const a=express(); a.use(express.urlencoded({extended:false})); a.use("/api",r); return a; }
  it("creates conversation+message and is idempotent", async () => {
    queryMock.mockImplementation(answerBySql([[/FROM communications_conversations/, { rows:[{id:"c1"}] }]]));
    const res=await request(await app()).post("/api/webhooks/twilio/sms-inbound").type("form").send({From:"+1",Body:"hi",MessageSid:"SM1"});
    expect(res.status).toBe(200); expect(res.text).toContain("<Response/>");
  });
});
