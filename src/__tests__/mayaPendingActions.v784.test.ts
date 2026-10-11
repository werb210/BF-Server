// BF_SERVER_v784_MAYA_SMS_CONFIRM - Maya queues SMS; only the staff member's confirm sends it, once.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";
const SECRET = process.env.JWT_SECRET as string;
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";

type Row = { id: string; kind: string; payload: any; staff_user_id: string | null; silo: string | null; status: string; result: any; created_at: string; expires_at: number };
const h = vi.hoisted(() => ({ rows: [] as any[], seq: 0, sendSms: null as any }));

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const now = () => Date.now();
  const query = async (sql: string, params: any[] = []) => {
    const rows = h.rows as Row[];
    if (/SELECT id FROM maya_pending_actions\s+WHERE kind = 'sms'/.test(sql)) {
      const [staff, to, body] = params;
      const r = rows.filter((x) => x.kind === "sms" && x.status === "pending" && x.expires_at > now() && x.staff_user_id === staff && x.payload.to === to && x.payload.body === body);
      return { rows: r.map((x) => ({ id: x.id })) };
    }
    if (/INSERT INTO maya_pending_actions/.test(sql)) {
      h.seq += 1;
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(h.seq).padStart(12, "0")}`;
      rows.push({ id, kind: "sms", payload: JSON.parse(params[0]), staff_user_id: params[1], silo: params[2], status: "pending", result: null, created_at: new Date().toISOString(), expires_at: now() + 30 * 60_000 });
      return { rows: [{ id }] };
    }
    if (/FROM maya_pending_actions\s+WHERE staff_user_id = \$1 AND status = 'pending'/.test(sql)) {
      return { rows: rows.filter((x) => x.staff_user_id === params[0] && x.status === "pending" && x.expires_at > now())
        .map(({ id, kind, payload, status, created_at, expires_at }) => ({ id, kind, payload, status, created_at, expires_at })) };
    }
    if (/SET status = 'sending'/.test(sql)) {
      const [id, staff, isAdmin] = params;
      const x = rows.find((r) => r.id === id && r.status === "pending" && r.expires_at > now() && (r.staff_user_id === staff || isAdmin));
      if (!x) return { rows: [] };
      x.status = "sending";
      return { rows: [{ id: x.id, kind: x.kind, payload: x.payload, staff_user_id: x.staff_user_id }] };
    }
    if (/SET status = 'cancelled'/.test(sql)) {
      const [id, staff, isAdmin] = params;
      const x = rows.find((r) => r.id === id && r.status === "pending" && (r.staff_user_id === staff || isAdmin));
      if (!x) return { rows: [] };
      x.status = "cancelled";
      return { rows: [{ id }] };
    }
    const setStatus = /UPDATE maya_pending_actions SET status = '(\w+)', result/.exec(sql);
    if (setStatus) {
      const x = rows.find((r) => r.id === params[0]);
      if (x) { x.status = setStatus[1]!; x.result = JSON.parse(params[1]); }
      return { rows: [] };
    }
    if (/SELECT status, staff_user_id/.test(sql)) {
      const x = rows.find((r) => r.id === params[0]);
      return { rows: x ? [{ status: x.status, staff_user_id: x.staff_user_id, expired: x.expires_at <= now() }] : [] };
    }
    return { rows: [], rowCount: 0 };
  };
  return { ...real, pool: { query }, runQuery: query };
});
vi.mock("../modules/notifications/sms.service.js", async (orig) => {
  const real: any = await orig();
  h.sendSms = vi.fn(async () => ({ sid: "SM123" }));
  return { ...real, sendSms: (...a: any[]) => h.sendSms(...a) };
});

import { API_ROUTE_MOUNTS } from "../routes/routeRegistry.js";

const app = express();
app.use(express.json());
app.use("/api/maya", API_ROUTE_MOUNTS.find((m) => m.path === "/maya")!.router);

const tok = (claims: object) => "Bearer " + jwt.sign(claims, SECRET, { algorithm: "HS256" });
const svc = tok({ kind: "service", service: "agent", source: "agent", principal: "service", id: "agent-service", role: "Staff" });
const me = tok({ id: ME, sub: ME, role: "Staff" });
const other = tok({ id: OTHER, sub: OTHER, role: "Staff" });
const admin = tok({ id: ADMIN, sub: ADMIN, role: "Admin" });
const client = tok({ sub: "client:+17805550100", role: "client", isClient: true, phone: "+17805550100" });

async function propose(body = "Your documents are in") {
  const r = await request(app).post("/api/maya/staff/send-sms").set("Authorization", svc)
    .send({ to: "+17805550100", body, staff_user_id: ME, contact_id: "c-1", approved: true });
  return r;
}

beforeEach(() => {
  h.rows.length = 0;
  h.sendSms.mockClear();
  h.sendSms.mockImplementation(async () => ({ sid: "SM123" }));
});

describe("v784 Maya SMS needs staff confirmation", () => {
  it("send-sms creates a pending row and does NOT send", async () => {
    const r = await propose();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, pending: true, preview: { to: "+17805550100", body: "Your documents are in" } });
    expect(typeof r.body.pendingId).toBe("string");
    expect(h.sendSms).not.toHaveBeenCalled();
    expect(h.rows[0]).toMatchObject({ kind: "sms", status: "pending", staff_user_id: ME, payload: { to: "+17805550100", body: "Your documents are in", contactId: "c-1" } });
  });

  it("send-sms without approved still never sends, and a repeat reuses the same pending row", async () => {
    const a = await request(app).post("/api/maya/staff/send-sms").set("Authorization", svc).send({ to: "+17805550100", body: "x", staff_user_id: ME });
    const b = await request(app).post("/api/maya/staff/send-sms").set("Authorization", svc).send({ to: "+17805550100", body: "x", staff_user_id: ME, approved: true });
    expect(a.body.pendingId).toBe(b.body.pendingId);
    expect(h.rows).toHaveLength(1);
    expect(h.sendSms).not.toHaveBeenCalled();
  });

  it("send-sms still validates and still requires the service token", async () => {
    expect((await request(app).post("/api/maya/staff/send-sms").set("Authorization", svc).send({ to: "+1" })).status).toBe(400);
    expect((await request(app).post("/api/maya/staff/send-sms").set("Authorization", me).send({ to: "+1", body: "x" })).status).toBe(401);
  });

  it("lists the caller's pending actions only", async () => {
    await propose();
    const mine = await request(app).get("/api/maya/pending-actions").set("Authorization", me);
    expect(mine.status).toBe(200);
    expect(mine.body.ok).toBe(true);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ kind: "sms", status: "pending", payload: { to: "+17805550100" } });
    const theirs = await request(app).get("/api/maya/pending-actions").set("Authorization", other);
    expect(theirs.body.items).toHaveLength(0);
  });

  it("confirm sends exactly once; a second confirm fails", async () => {
    const { body } = await propose();
    const c1 = await request(app).post(`/api/maya/pending-actions/${body.pendingId}/confirm`).set("Authorization", me);
    expect(c1.status).toBe(200);
    expect(c1.body).toMatchObject({ ok: true, status: "sent" });
    expect(h.sendSms).toHaveBeenCalledTimes(1);
    expect(h.sendSms).toHaveBeenCalledWith({ to: "+17805550100", message: "Your documents are in" });
    expect(h.rows[0]).toMatchObject({ status: "sent", result: { sid: "SM123" } });
    const c2 = await request(app).post(`/api/maya/pending-actions/${body.pendingId}/confirm`).set("Authorization", me);
    expect(c2.status).toBe(409);
    expect(c2.body.ok).toBe(false);
    expect(h.sendSms).toHaveBeenCalledTimes(1);
  });

  it("a failed send is marked failed with the error", async () => {
    h.sendSms.mockImplementation(async () => { throw new Error("twilio down"); });
    const { body } = await propose();
    const c = await request(app).post(`/api/maya/pending-actions/${body.pendingId}/confirm`).set("Authorization", me);
    expect(c.body).toMatchObject({ ok: false, status: "failed" });
    expect(h.rows[0]).toMatchObject({ status: "failed", result: { error: "twilio down" } });
  });

  it("another staff member cannot confirm; an Admin can", async () => {
    const { body } = await propose();
    const o = await request(app).post(`/api/maya/pending-actions/${body.pendingId}/confirm`).set("Authorization", other);
    expect(o.status).toBe(403);
    expect(h.sendSms).not.toHaveBeenCalled();
    const a = await request(app).post(`/api/maya/pending-actions/${body.pendingId}/confirm`).set("Authorization", admin);
    expect(a.status).toBe(200);
    expect(a.body.status).toBe("sent");
    expect(h.sendSms).toHaveBeenCalledTimes(1);
  });

  it("cancel marks it cancelled and it can no longer be confirmed", async () => {
    const { body } = await propose();
    expect((await request(app).post(`/api/maya/pending-actions/${body.pendingId}/cancel`).set("Authorization", other)).status).toBe(403);
    const c = await request(app).post(`/api/maya/pending-actions/${body.pendingId}/cancel`).set("Authorization", me);
    expect(c.status).toBe(200);
    expect(c.body).toEqual({ ok: true, status: "cancelled" });
    const conf = await request(app).post(`/api/maya/pending-actions/${body.pendingId}/confirm`).set("Authorization", me);
    expect(conf.status).toBe(409);
    expect(h.sendSms).not.toHaveBeenCalled();
  });

  it("an expired action cannot be confirmed", async () => {
    const { body } = await propose();
    h.rows[0].expires_at = Date.now() - 1000;
    const c = await request(app).post(`/api/maya/pending-actions/${body.pendingId}/confirm`).set("Authorization", me);
    expect(c.status).toBe(410);
    expect(h.sendSms).not.toHaveBeenCalled();
    const list = await request(app).get("/api/maya/pending-actions").set("Authorization", me);
    expect(list.body.items).toHaveLength(0);
  });

  it("service, client and anonymous callers are rejected", async () => {
    const { body } = await propose();
    for (const path of ["/api/maya/pending-actions"]) {
      expect((await request(app).get(path).set("Authorization", svc)).status).toBe(403);
      expect((await request(app).get(path).set("Authorization", client)).status).toBe(403);
      expect((await request(app).get(path)).status).toBe(401);
    }
    expect((await request(app).post(`/api/maya/pending-actions/${body.pendingId}/confirm`).set("Authorization", svc)).status).toBe(403);
    expect((await request(app).post(`/api/maya/pending-actions/${body.pendingId}/cancel`).set("Authorization", svc)).status).toBe(403);
    expect(h.sendSms).not.toHaveBeenCalled();
    expect(h.rows[0].status).toBe("pending");
  });
});
