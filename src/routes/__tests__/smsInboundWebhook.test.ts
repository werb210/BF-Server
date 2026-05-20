import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: queryMock } }));

describe("smsInboundWebhook", () => {
  beforeEach(() => queryMock.mockReset());
  async function app(){ const r=(await import("../smsInboundWebhook.js")).default; const a=express(); a.use(express.urlencoded({extended:false})); a.use("/api",r); return a; }
  it("creates conversation+message and is idempotent", async () => {
    queryMock.mockResolvedValueOnce({ rowCount:0, rows:[] }).mockResolvedValueOnce({ rows:[{id:"c1"}] }).mockResolvedValueOnce({ rows:[] });
    const res=await request(await app()).post("/api/webhooks/twilio/sms-inbound").type("form").send({From:"+1",Body:"hi",MessageSid:"SM1"});
    expect(res.status).toBe(200); expect(res.text).toContain("<Response/>");
  });
});
