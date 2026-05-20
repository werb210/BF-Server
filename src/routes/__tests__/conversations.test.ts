import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { queryMock, sendSmsMock } = vi.hoisted(() => ({ queryMock: vi.fn(), sendSmsMock: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: queryMock } }));
vi.mock("../../services/twilioService.js", () => ({ sendSms: sendSmsMock }));

describe("conversations routes", () => {
  beforeEach(() => { process.env.JWT_SECRET="test-secret"; queryMock.mockReset(); sendSmsMock.mockReset(); });
  async function app() { const r = (await import("../conversations.js")).default; const a = express(); a.use(express.json()); a.use((req:any,res:any,next:any)=>{req.user={id:"u1",role:"admin"};res.locals.silo="BF";next();}); a.use("/api", r); return a; }
  it("GET /conversations returns list", async () => { queryMock.mockResolvedValueOnce({ rows:[{id:"c1",channel:"messenger"}] }); const res=await request(await app()).get("/api/conversations?channel=messenger").set("authorization",`Bearer ${jwt.sign({id:"u1",role:"admin"},"test-secret")}`); expect(res.status).toBe(200); expect(res.body.conversations[0].id).toBe("c1"); });
  it("GET messages returns ordered rows", async () => { queryMock.mockResolvedValueOnce({ rows:[{id:"m1"},{id:"m2"}] }); const res=await request(await app()).get("/api/conversations/c1/messages").set("authorization",`Bearer ${jwt.sign({id:"u1",role:"admin"},"test-secret")}`); expect(res.status).toBe(200); expect(res.body.messages.map((m:any)=>m.id)).toEqual(["m1","m2"]); });
  it("POST messages inserts and updates preview", async () => { queryMock.mockResolvedValueOnce({ rowCount:1, rows:[{contact_phone:null,channel:"messenger"}] }).mockResolvedValueOnce({ rows:[{id:"m3",created_at:"2026-01-01"}] }).mockResolvedValueOnce({ rows:[] }); const res=await request(await app()).post("/api/conversations/c1/messages").set("authorization",`Bearer ${jwt.sign({id:"u1",role:"admin"},"test-secret")}`).send({body:"hello"}); expect(res.status).toBe(201); expect(res.body.id).toBe("m3"); });
});
