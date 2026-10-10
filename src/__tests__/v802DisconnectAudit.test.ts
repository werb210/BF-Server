// BF_SERVER_O365_DISCONNECT_v802 + BF_SERVER_AUDIT_ACTIVITY_v802
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const q = vi.hoisted(() => ({ calls: [] as Array<{ sql: string; params: any[] }> }));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "11111111-1111-1111-1111-111111111111", role: "Staff" }; next(); },
}));
vi.mock("../db.js", () => ({
  pool: { query: vi.fn(async (sql: string, params: any[] = []) => { q.calls.push({ sql, params }); return { rowCount: 1, rows: [] }; }) },
  runQuery: vi.fn(),
}));
vi.mock("../observability/requestContext.js", () => ({ fetchRequestId: () => null, fetchRequestServiceName: () => null }));
import o365OAuth from "../routes/o365OAuth.js";
import auditActivity from "../routes/auditActivity.js";

const app = express();
app.use(express.json());
app.use("/api/o365-oauth", o365OAuth);
app.use("/api/audit", auditActivity);
beforeEach(() => { q.calls.length = 0; });

describe("v802", () => {
  it("Disconnect forgets the user's Microsoft tokens on the server", async () => {
    const r = await request(app).post("/api/o365-oauth/disconnect").send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, connected: false });
    const upd = q.calls.find((c) => c.sql.includes("UPDATE users"))!;
    expect(upd.sql).toContain("o365_access_token = NULL");
    expect(upd.sql).toContain("o365_refresh_token = NULL");
    expect(upd.params).toEqual(["11111111-1111-1111-1111-111111111111"]);
  });
  it("records a bulk pipeline move in audit_events", async () => {
    const r = await request(app).post("/api/audit/activity").send({ action: "pipeline_move", metadata: { count: 2 } });
    expect(r.status).toBe(201);
    const ins = q.calls.find((c) => c.sql.includes("insert into audit_events"))!;
    expect(ins.params).toContain("portal.pipeline_move");
    expect(ins.params).toContain(JSON.stringify({ count: 2 }));
  });
  it("refuses an activity with no action", async () => {
    expect((await request(app).post("/api/audit/activity").send({})).status).toBe(400);
  });
});
