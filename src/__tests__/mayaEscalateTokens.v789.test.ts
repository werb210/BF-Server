// BF_SERVER_v789_CONVERSATION_TOKENS + BF_SERVER_v789_ESCALATE_LIMITS
// /api/maya/escalate returned a contact's EXISTING conversation id to anyone who
// typed that contact's name and phone, and the public conversation endpoints
// treated that id as the only credential.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const CONV = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const OTHER_CONV = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";

const state = vi.hoisted(() => ({
  tokens: [] as Array<{ conversation_id: string; token_hash: string; created_at: string; expired: boolean }>,
  sqls: [] as Array<{ sql: string; params: unknown[] }>,
  sms: 0,
  ip: 1,
}));

function answer(sql: string, params: unknown[] = []) {
  state.sqls.push({ sql, params });
  if (sql.includes("INSERT INTO public_conversation_tokens")) {
    state.tokens.push({ conversation_id: String(params[0]), token_hash: String(params[1]), created_at: "2026-10-11 12:00:00.123456+00", expired: false });
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes("FROM public_conversation_tokens")) {
    const t = state.tokens.find((x) => x.conversation_id === params[0] && x.token_hash === params[1] && !x.expired);
    return { rows: t ? [{ created_at: t.created_at }] : [] };
  }
  if (/FROM contacts/.test(sql)) return { rows: [{ id: "k1" }] };
  if (/SELECT id FROM communications_conversations/.test(sql)) return { rows: [{ id: CONV }] };
  if (/FROM communications_conversations WHERE id = \$1/.test(sql)) {
    return { rows: params[0] === CONV ? [{ id: CONV, contact_id: "k1", silo: "BF", contact_phone: "+15875550100" }] : [] };
  }
  if (/FROM communications_messages/.test(sql)) return { rows: [{ id: "m-new", direction: "outbound", body: "hi", created_at: "x" }] };
  if (/INSERT INTO communications_messages/.test(sql)) return { rows: [{ id: "m1", direction: "inbound", body: "b", created_at: "x" }] };
  return { rows: [], rowCount: 0 };
}

vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = async (sql: string, params?: unknown[]) => answer(String(sql), params ?? []);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../services/contacts.js", () => ({ createContact: async () => ({ id: "k-new" }) }));
vi.mock("../services/notifications/staffSms.js", () => ({
  sendStaffNotification: async () => {
    state.sms += 1;
  },
}));

async function escalateApp() {
  const { default: r } = await import("../routes/mayaEscalate.js");
  const a = express();
  a.use(express.json({ limit: "10mb" }));
  a.use("/api", r);
  return a;
}
async function publicApp() {
  const { default: r } = await import("../routes/public.js");
  const a = express();
  a.use(express.json());
  a.use("/api/public", r);
  return a;
}
const nextIp = () => `10.1.${Math.floor(state.ip / 250)}.${(state.ip++ % 250) + 1}`;
const talk = (contact: Record<string, string>, extra: Record<string, unknown> = {}) => ({ kind: "talk_to_human", message: "help", contact, ...extra });
const flush = () => new Promise((r) => setTimeout(r, 20));

beforeEach(async () => {
  state.tokens.length = 0;
  state.sqls.length = 0;
  state.sms = 0;
  const { resetStaffAlertThrottleForTests } = await import("../routes/mayaEscalate.js");
  resetStaffAlertThrottleForTests();
});

describe("escalate issues a fresh visitor token", () => {
  it("returns conversation_id and a 32-byte base64url visitor_token whose sha256 is stored with a 30-day expiry", async () => {
    const r = await request(await escalateApp()).post("/api/maya/escalate").set("X-Forwarded-For", nextIp())
      .send(talk({ name: "Jane Doe", phone: "+15875550100" }));
    expect(r.status).toBe(201);
    expect(r.body.conversation_id).toBe(CONV);
    expect(r.body.visitor_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ins = state.sqls.find((s) => s.sql.includes("INSERT INTO public_conversation_tokens"))!;
    expect(ins.params[0]).toBe(CONV);
    expect(ins.params[1]).toBe(createHash("sha256").update(r.body.visitor_token).digest("hex"));
    expect(ins.params[2]).toBe(30);
    // The token is issued before the handoff marker is written, so the visitor sees the marker.
    const tokenAt = state.sqls.findIndex((s) => s.sql.includes("INSERT INTO public_conversation_tokens"));
    const msgAt = state.sqls.findIndex((s) => s.sql.includes("INSERT INTO communications_messages"));
    expect(tokenAt).toBeLessThan(msgAt);
  });

  it("each escalate on the same existing conversation gets a different token", async () => {
    const a = await escalateApp();
    const one = await request(a).post("/api/maya/escalate").set("X-Forwarded-For", nextIp()).send(talk({ name: "Jane Doe", phone: "+15875550100" }));
    const two = await request(a).post("/api/maya/escalate").set("X-Forwarded-For", nextIp()).send(talk({ name: "Jane Doe", phone: "+15875550100" }));
    expect(one.body.conversation_id).toBe(two.body.conversation_id);
    expect(one.body.visitor_token).not.toBe(two.body.visitor_token);
  });
});

describe("public conversation endpoints require X-Conversation-Token", () => {
  async function issued(): Promise<string> {
    const r = await request(await escalateApp()).post("/api/maya/escalate").set("X-Forwarded-For", nextIp()).send(talk({ name: "Jane Doe", phone: "+15875550100" }));
    return r.body.visitor_token;
  }

  it("GET without a token -> 401 and no message read", async () => {
    const r = await request(await publicApp()).get(`/api/public/conversation/${CONV}/messages`);
    expect(r.status).toBe(401);
    expect(state.sqls.some((s) => /FROM communications_messages/.test(s.sql))).toBe(false);
  });

  it("GET with a wrong token, or a token for another conversation -> 401", async () => {
    const tok = await issued();
    const a = await publicApp();
    expect((await request(a).get(`/api/public/conversation/${CONV}/messages`).set("X-Conversation-Token", "nope")).status).toBe(401);
    expect((await request(a).get(`/api/public/conversation/${OTHER_CONV}/messages`).set("X-Conversation-Token", tok)).status).toBe(401);
  });

  it("GET with an expired token -> 401", async () => {
    const tok = await issued();
    state.tokens.forEach((t) => (t.expired = true));
    const r = await request(await publicApp()).get(`/api/public/conversation/${CONV}/messages`).set("X-Conversation-Token", tok);
    expect(r.status).toBe(401);
  });

  it("GET with the token returns only messages created at or after the token", async () => {
    const tok = await issued();
    const r = await request(await publicApp()).get(`/api/public/conversation/${CONV}/messages`).set("X-Conversation-Token", tok);
    expect(r.status).toBe(200);
    const read = state.sqls.find((s) => /FROM communications_messages/.test(s.sql))!;
    expect(read.sql).toMatch(/created_at >= \(\$2\)::timestamptz/);
    expect(read.params).toEqual([CONV, "2026-10-11 12:00:00.123456+00"]);
  });

  it("POST without a token -> 401 and nothing written; with the token -> 201", async () => {
    const tok = await issued();
    const a = await publicApp();
    state.sqls.length = 0;
    const no = await request(a).post(`/api/public/conversation/${CONV}/message`).set("X-Forwarded-For", nextIp()).send({ body: "hello" });
    expect(no.status).toBe(401);
    expect(state.sqls.some((s) => /INSERT INTO communications_messages/.test(s.sql))).toBe(false);
    const yes = await request(a).post(`/api/public/conversation/${CONV}/message`).set("X-Forwarded-For", nextIp()).set("X-Conversation-Token", tok).send({ body: "hello" });
    expect(yes.status).toBe(201);
  });
});

describe("escalate limits", () => {
  it("5 a minute per IP", async () => {
    const a = await escalateApp();
    const ip = "192.0.2.10";
    for (let i = 0; i < 5; i += 1) {
      const r = await request(a).post("/api/maya/escalate").set("X-Forwarded-For", ip).send(talk({ name: "A B", email: `ip${i}@x.test` }));
      expect(r.status).toBe(201);
    }
    const r = await request(a).post("/api/maya/escalate").set("X-Forwarded-For", ip).send(talk({ name: "A B", email: "ip9@x.test" }));
    expect(r.status).toBe(429);
  });

  it("20 a day per phone, regardless of IP", async () => {
    const a = await escalateApp();
    for (let i = 0; i < 20; i += 1) {
      const r = await request(a).post("/api/maya/escalate").set("X-Forwarded-For", nextIp()).send(talk({ name: "A B", phone: "(403) 555-0177" }));
      expect(r.status).toBe(201);
    }
    const r = await request(a).post("/api/maya/escalate").set("X-Forwarded-For", nextIp()).send(talk({ name: "A B", phone: "+14035550177" }));
    expect(r.status).toBe(429);
  });

  it("20 a day per email, regardless of IP", async () => {
    const a = await escalateApp();
    for (let i = 0; i < 20; i += 1) {
      const r = await request(a).post("/api/maya/escalate").set("X-Forwarded-For", nextIp()).send(talk({ name: "A B", email: "Flood@X.test" }));
      expect(r.status).toBe(201);
    }
    const r = await request(a).post("/api/maya/escalate").set("X-Forwarded-For", nextIp()).send(talk({ name: "A B", email: "flood@x.test" }));
    expect(r.status).toBe(429);
  });

  it("the staff SMS goes out at most once per contact per 10 minutes", async () => {
    const a = await escalateApp();
    for (let i = 0; i < 3; i += 1) {
      await request(a).post("/api/maya/escalate").set("X-Forwarded-For", nextIp()).send(talk({ name: "Jane Doe", phone: "+15875550111" }));
    }
    await flush();
    expect(state.sms).toBe(1);
    const { claimStaffAlert, STAFF_ALERT_COOLDOWN_MS } = await import("../routes/mayaEscalate.js");
    const now = Date.now();
    expect(claimStaffAlert("talk_to_human:other", now)).toBe(true);
    expect(claimStaffAlert("talk_to_human:other", now + STAFF_ALERT_COOLDOWN_MS - 1)).toBe(false);
    expect(claimStaffAlert("talk_to_human:other", now + STAFF_ALERT_COOLDOWN_MS)).toBe(true);
  });
});

describe("public conversation message rate limit", () => {
  it("20 a minute per IP", async () => {
    const tokRes = await request(await escalateApp()).post("/api/maya/escalate").set("X-Forwarded-For", nextIp()).send(talk({ name: "Jane Doe", phone: "+15875550100" }));
    const a = await publicApp();
    const ip = "192.0.2.20";
    for (let i = 0; i < 20; i += 1) {
      const r = await request(a).post(`/api/public/conversation/${CONV}/message`).set("X-Forwarded-For", ip).set("X-Conversation-Token", tokRes.body.visitor_token).send({ body: "m" + i });
      expect(r.status).toBe(201);
    }
    const r = await request(a).post(`/api/public/conversation/${CONV}/message`).set("X-Forwarded-For", ip).set("X-Conversation-Token", tokRes.body.visitor_token).send({ body: "again" });
    expect(r.status).toBe(429);
  });
});
