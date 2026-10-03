// BF_SERVER_BROKER_PORTAL_v717
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";

const state: { kind: string; status: string; owns: boolean; deal: string | null; updates: Array<{ sql: string; params: unknown[] }> } = { kind: "broker", status: "active", owns: true, deal: "proposed", updates: [] };
vi.mock("../db.js", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/FROM users WHERE id::text/.test(sql)) return { rows: [{ company: "Avance", name: "Jeremy Girard", partner_kind: state.kind, referrer_status: state.status }] };
      if (/SELECT 1 FROM broker_imports/.test(sql)) return { rows: state.owns ? [{ "?column?": 1 }] : [] };
      if (/SELECT status FROM broker_deal_confirmations/.test(sql)) return { rows: state.deal ? [{ status: state.deal }] : [] };
      if (/UPDATE broker_deal_confirmations/.test(sql)) { state.updates.push({ sql, params }); return { rows: [{ status: "accepted" }] }; }
      return { rows: [] };
    }),
  },
}));

process.env.JWT_SECRET = "test-secret-1234567890";
const token = (role = "Referrer") => jwt.sign({ role, referrerId: "u1" }, process.env.JWT_SECRET!);
async function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/broker", (await import("../routes/brokerSelf.js")).default);
  return a;
}

beforeEach(() => { state.kind = "broker"; state.status = "active"; state.owns = true; state.deal = "proposed"; state.updates = []; });

describe("broker portal access", () => {
  it("referrers who are not brokers, and brokers who have not signed, are refused", async () => {
    state.kind = "referrer";
    expect((await request(await app()).get("/api/broker/me").set("Authorization", "Bearer " + token())).status).toBe(403);
    state.kind = "broker"; state.status = "pending_agreement";
    const r = await request(await app()).get("/api/broker/me").set("Authorization", "Bearer " + token());
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("agreement_not_signed");
  });
  it("a signed broker gets in", async () => {
    const r = await request(await app()).get("/api/broker/me").set("Authorization", "Bearer " + token());
    expect(r.status).toBe(200);
    expect(r.body.broker.company).toBe("Avance");
  });
});

describe("agreeing the split", () => {
  it("the broker accepts Boreal's proposal, which locks it", async () => {
    const r = await request(await app()).post("/api/broker/files/app1/split").set("Authorization", "Bearer " + token()).send({ action: "accept" });
    expect(r.status).toBe(200);
    expect(state.updates[0].sql).toContain("status = 'accepted'");
  });
  it("or counters with their own share", async () => {
    const r = await request(await app()).post("/api/broker/files/app1/split").set("Authorization", "Bearer " + token()).send({ action: "counter", broker_pct: 60, note: "client is mine" });
    expect(r.status).toBe(200);
    expect(state.updates[0].params).toEqual(["app1", 60, "client is mine"]);
  });
  it("cannot touch another broker's file, a file with no proposal, or a counter Boreal has not answered", async () => {
    state.owns = false;
    expect((await request(await app()).post("/api/broker/files/app1/split").set("Authorization", "Bearer " + token()).send({ action: "accept" })).status).toBe(404);
    state.owns = true; state.deal = null;
    expect((await request(await app()).post("/api/broker/files/app1/split").set("Authorization", "Bearer " + token()).send({ action: "accept" })).status).toBe(409);
    state.deal = "countered";
    expect((await request(await app()).post("/api/broker/files/app1/split").set("Authorization", "Bearer " + token()).send({ action: "accept" })).status).toBe(409);
  });
});

describe("sign-up and files", () => {
  it("brokers see status only - the file list has no lender names or offer terms", () => {
    const src = readFileSync("src/routes/brokerSelf.ts", "utf8");
    const list = src.slice(src.indexOf('router.get("/files"'), src.indexOf('router.post("/files"'));
    expect(list).not.toMatch(/lender|offers/i);
  });
});
