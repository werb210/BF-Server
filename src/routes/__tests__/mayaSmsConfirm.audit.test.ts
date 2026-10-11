// BF_SERVER_MAYA_SMS_CONFIRM_v1 - Maya sent an SMS whenever the model set
// approved=true. Now send-sms only creates a pending draft and a human staff
// member's click in the portal (confirm) is the only thing that sends.
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, sendSmsMock } = vi.hoisted(() => ({ queryMock: vi.fn(), sendSmsMock: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: queryMock } }));
vi.mock("../../modules/notifications/sms.service.js", () => ({ sendSms: sendSmsMock }));

const SECRET = "test-jwt-secret";
const STAFF_A = "66666666-6666-4666-8666-666666666666";
const STAFF_B = "77777777-7777-4777-8777-777777777777";
const sign = (c: Record<string, unknown>) => jwt.sign(c, SECRET, { expiresIn: "5m" });
const agent = sign({ kind: "service", service: "agent", source: "agent", principal: "service", id: "agent-service", role: "Staff" });
const staffA = sign({ sub: STAFF_A, role: "Staff" });
const staffB = sign({ sub: STAFF_B, role: "Staff" });
const client = sign({ sub: "client:+15555550123", role: "client", phone: "+15555550123", isClient: true });

type Row = { id: string; kind: string; payload: any; staff_user_id: string | null; status: string; expires_at: number; result?: any };
let rows: Row[] = [];
let seq = 0;

function db(sql: string, p: any[] = []) {
  if (/INSERT INTO maya_pending_actions/.test(sql)) {
    const id = `0000000${++seq}-0000-4000-8000-000000000000`.slice(-36);
    rows.push({ id, kind: "sms", payload: JSON.parse(p[0]), staff_user_id: p[1], status: "pending", expires_at: Date.now() + 30 * 60e3 });
    return { rows: [{ id }] };
  }
  if (/FROM maya_pending_actions\s+WHERE staff_user_id = \$1 AND status = 'pending'/.test(sql)) {
    return { rows: rows.filter((r) => r.staff_user_id === p[0] && r.status === "pending" && r.expires_at > Date.now()) };
  }
  if (/UPDATE maya_pending_actions\s+SET status = 'sent'/.test(sql)) {
    const r = rows.find((x) => x.id === p[0] && x.status === "pending" && x.expires_at > Date.now() && (x.staff_user_id === p[1] || p[2]));
    if (!r) return { rows: [] };
    r.status = "sent";
    return { rows: [{ id: r.id, kind: r.kind, payload: r.payload }] };
  }
  if (/UPDATE maya_pending_actions\s+SET status = 'cancelled'/.test(sql)) {
    const r = rows.find((x) => x.id === p[0] && x.status === "pending" && (x.staff_user_id === p[1] || p[2]));
    if (!r) return { rows: [] };
    r.status = "cancelled";
    return { rows: [{ id: r.id }] };
  }
  if (/SELECT status, \(expires_at <= now\(\)\) AS expired/.test(sql)) {
    const r = rows.find((x) => x.id === p[0]);
    return { rows: r ? [{ status: r.status, expired: r.expires_at <= Date.now(), staff_user_id: r.staff_user_id }] : [] };
  }
  if (/UPDATE maya_pending_actions SET result/.test(sql)) return { rows: [] };
  if (/FROM users WHERE id = \$1/.test(sql)) return { rows: [{ id: p[0], email: "x@example.com", role: "Staff", silo: "BF", silos: ["BF"] }] };
  return { rows: [] };
}

async function app() {
  const router = (await import("../mayaStaff.js")).default;
  const a = express();
  a.use(express.json());
  a.use("/api/maya", router);
  return a;
}

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  rows = [];
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, p?: any[]) => db(sql, p));
  sendSmsMock.mockReset();
  sendSmsMock.mockResolvedValue({ sid: "SM123" });
});

async function draft(a: express.Express, staffUserId = STAFF_A) {
  return request(a).post("/api/maya/staff/send-sms").set("Authorization", `Bearer ${agent}`)
    .send({ to: "+15555550123", body: "Your documents are in.", staff_user_id: staffUserId, approved: true });
}

describe("Maya SMS needs a human click", () => {
  it("send-sms never sends, even with approved=true; it returns a pending draft", async () => {
    const r = await draft(await app());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, pending: true, preview: { to: "+15555550123", body: "Your documents are in." } });
    expect(typeof r.body.pendingId).toBe("string");
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("send-sms requires the agent's service token", async () => {
    const r = await request(await app()).post("/api/maya/staff/send-sms").set("Authorization", `Bearer ${staffA}`).send({ to: "+15555550123", body: "x" });
    expect(r.status).toBe(401);
  });

  it("the owner lists and confirms; the SMS goes out once", async () => {
    const a = await app();
    const { body } = await draft(a);
    const list = await request(a).get("/api/maya/pending-actions").set("Authorization", `Bearer ${staffA}`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: any) => i.id)).toEqual([body.pendingId]);
    const ok = await request(a).post(`/api/maya/pending-actions/${body.pendingId}/confirm`).set("Authorization", `Bearer ${staffA}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, status: "sent" });
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    expect(sendSmsMock).toHaveBeenCalledWith({ to: "+15555550123", message: "Your documents are in." });
    const again = await request(a).post(`/api/maya/pending-actions/${body.pendingId}/confirm`).set("Authorization", `Bearer ${staffA}`);
    expect(again.status).toBe(409);
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
  });

  it("another staff member cannot see or confirm it", async () => {
    const a = await app();
    const { body } = await draft(a);
    const list = await request(a).get("/api/maya/pending-actions").set("Authorization", `Bearer ${staffB}`);
    expect(list.body.items).toEqual([]);
    const r = await request(a).post(`/api/maya/pending-actions/${body.pendingId}/confirm`).set("Authorization", `Bearer ${staffB}`);
    expect(r.status).toBe(404);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("the agent's service token and client tokens cannot confirm or list", async () => {
    const a = await app();
    const { body } = await draft(a);
    expect((await request(a).post(`/api/maya/pending-actions/${body.pendingId}/confirm`).set("Authorization", `Bearer ${agent}`)).status).toBe(403);
    expect((await request(a).get("/api/maya/pending-actions").set("Authorization", `Bearer ${agent}`)).status).toBe(403);
    expect((await request(a).post(`/api/maya/pending-actions/${body.pendingId}/confirm`).set("Authorization", `Bearer ${client}`)).status).toBe(403);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("cancel marks it cancelled and it can no longer be sent", async () => {
    const a = await app();
    const { body } = await draft(a);
    const c = await request(a).post(`/api/maya/pending-actions/${body.pendingId}/cancel`).set("Authorization", `Bearer ${staffA}`);
    expect(c.body).toMatchObject({ ok: true, status: "cancelled" });
    const r = await request(a).post(`/api/maya/pending-actions/${body.pendingId}/confirm`).set("Authorization", `Bearer ${staffA}`);
    expect(r.status).toBe(409);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("an expired draft is refused with 410", async () => {
    const a = await app();
    const { body } = await draft(a);
    rows[0].expires_at = Date.now() - 1000;
    const r = await request(a).post(`/api/maya/pending-actions/${body.pendingId}/confirm`).set("Authorization", `Bearer ${staffA}`);
    expect(r.status).toBe(410);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });
});

describe("the migration", () => {
  it("creates maya_pending_actions idempotently with the contract columns", async () => {
    const fs = await import("node:fs");
    const sql = fs.readFileSync("migrations/2026_10_11_maya_pending_actions.sql", "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS maya_pending_actions");
    for (const col of ["kind text NOT NULL", "payload jsonb NOT NULL", "staff_user_id text NULL", "silo text NULL", "status text NOT NULL DEFAULT 'pending'", "result jsonb NULL", "decided_at timestamptz NULL", "expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes')"]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS");
  });
});
