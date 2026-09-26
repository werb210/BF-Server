// BF_SERVER_BLOCK_v578 - answers each query by what it asks for instead of by call order (the
// auth lookup comes first), and covers the error path: a failed query now returns 500 instead
// of leaving the request hanging (the handlers had no safeHandler under Express 4).
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, sendSmsMock } = vi.hoisted(() => ({ queryMock: vi.fn(), sendSmsMock: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: queryMock } }));
vi.mock("../../modules/notifications/sms.service.js", () => ({ sendSms: sendSmsMock }));

const USER = { id: "u1", email: "u1@example.com", role: "Admin", silo: "BF", silos: ["BF"] };
function routeSql(rowsFor: (sql: string) => { rows: any[]; rowCount?: number } | Error) {
  queryMock.mockImplementation(async (sql: string) => {
    const s = String(sql);
    if (/FROM users/i.test(s)) return { rows: [USER], rowCount: 1 };
    const r = rowsFor(s);
    if (r instanceof Error) throw r;
    return r;
  });
}
const auth = () => `Bearer ${jwt.sign({ id: "u1", role: "Admin" }, "test-secret")}`;

describe("conversations routes", () => {
  beforeEach(() => { process.env.JWT_SECRET = "test-secret"; queryMock.mockReset(); sendSmsMock.mockReset(); });
  async function app() {
    const r = (await import("../conversations.js")).default;
    const a = express(); a.use(express.json());
    a.use((_req: any, res: any, next: any) => { res.locals.silo = "BF"; next(); });
    a.use("/api", r);
    a.use((err: any, _req: any, res: any, _next: any) => res.status(err?.status ?? 500).json({ error: "internal" }));
    return a;
  }

  it("GET /conversations returns list", async () => {
    routeSql((sql) => (/FROM communications_conversations/.test(sql) ? { rows: [{ id: "c1", channel: "messenger" }] } : { rows: [] }));
    const res = await request(await app()).get("/api/conversations?channel=messenger").set("authorization", auth());
    expect(res.status).toBe(200);
    expect(res.body.conversations[0].id).toBe("c1");
  });

  it("GET messages returns ordered rows", async () => {
    routeSql((sql) => (/FROM communications_messages/.test(sql) ? { rows: [{ id: "m1" }, { id: "m2" }] } : { rows: [] }));
    const res = await request(await app()).get("/api/conversations/c1/messages").set("authorization", auth());
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: any) => m.id)).toEqual(["m1", "m2"]);
  });

  it("POST messages inserts and updates preview", async () => {
    routeSql((sql) => {
      if (/SELECT contact_phone, channel FROM communications_conversations/.test(sql)) return { rows: [{ contact_phone: null, channel: "messenger" }], rowCount: 1 };
      if (/INSERT INTO communications_messages/.test(sql)) return { rows: [{ id: "m3", created_at: "2026-01-01" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const res = await request(await app()).post("/api/conversations/c1/messages").set("authorization", auth()).send({ body: "hello" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("m3");
  });

  it("a database failure answers 500 instead of hanging", async () => {
    routeSql(() => new Error("db down"));
    const res = await request(await app()).get("/api/conversations").set("authorization", auth());
    expect(res.status).toBe(500);
  });
});
