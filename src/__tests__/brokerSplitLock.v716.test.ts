// BF_SERVER_BROKER_SPLIT_LOCK_v716
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const h = vi.hoisted(() => ({ row: null as any, query: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query: h.query } }));
h.query.mockImplementation(async (sql: string, params?: unknown[]) => {
  if (/FROM applications a LEFT JOIN broker_deal_confirmations/.test(sql)) return { rows: h.row ? [h.row] : [] };
  if (/broker_name FROM applications WHERE id::text=\$1/.test(sql)) return { rows: [{ broker_name: "Avance" }] };
  if (/INSERT INTO broker_deal_confirmations/.test(sql)) return { rows: [{ application_id: params?.[0], status: params?.[9] }] };
  if (/UPDATE broker_deal_confirmations SET payout_amount/.test(sql)) return { rows: [{ application_id: params?.[0], payout_amount: params?.[1] }] };
  return { rows: [] };
});
import { brokerSplitBlocker } from "../services/brokerImport/splitLock.js";
import brokerImportsRouter from "../routes/brokerImports.js";

function staffApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/broker-imports", brokerImportsRouter);
  return app;
}
const staff = () =>
  `Bearer ${jwt.sign({ sub: "00000000-0000-0000-0000-000000000001", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string)}`;

describe("broker files are locked until the split is accepted", () => {
  it("a normal (non-broker) file is never blocked", async () => {
    h.row = null;
    expect(await brokerSplitBlocker("a1")).toEqual({ blocked: false });
  });
  it("a broker file with no split, or only a proposal, is blocked", async () => {
    h.row = { broker: "Avance", status: null };
    expect(await brokerSplitBlocker("a1")).toEqual({ blocked: true, status: null, broker: "Avance" });
    h.row = { broker: "Avance", status: "proposed" };
    expect((await brokerSplitBlocker("a1")).blocked).toBe(true);
  });
  it("an accepted split unlocks it", async () => {
    h.row = { broker: "Avance", status: "accepted" };
    expect(await brokerSplitBlocker("a1")).toEqual({ blocked: false });
  });
  it("the lender send route checks it before submitting", () => {
    const src = readFileSync("src/routes/portal.ts", "utf8");
    const i = src.indexOf('\"/lender-submissions\"');
    expect(src.indexOf("brokerSplitBlocker(applicationId)", i)).toBeGreaterThan(i);
    expect(src).toContain('error: "broker_split_not_agreed"');
  });
  // BF_SERVER_v789 - behaviour rather than source text.
  it("staff entering who agreed for the broker locks it; otherwise it is a proposal; payouts recorded", async () => {
    const app = staffApp();
    const accepted = await request(app).put("/api/broker-imports/deal/a1").set("Authorization", staff())
      .send({ boreal_pct: 60, broker_pct: 40, agreed_by_broker: "Pat at Avance", agreed_on: "2026-10-01" });
    expect(accepted.status).toBe(200);
    expect(accepted.body.deal.status).toBe("accepted");
    const proposed = await request(app).put("/api/broker-imports/deal/a1").set("Authorization", staff())
      .send({ boreal_pct: 60, broker_pct: 40 });
    expect(proposed.body.deal.status).toBe("proposed");
    expect((await request(app).put("/api/broker-imports/deal/a1").set("Authorization", staff()).send({ boreal_pct: 70, broker_pct: 40 })).body.error).toBe("split_not_100");
    const payout = await request(app).put("/api/broker-imports/deal/a1/payout").set("Authorization", staff()).send({ payout_amount: 1500, payout_paid_on: "2026-10-05" });
    expect(payout.status).toBe(200);
    expect(payout.body.deal.payout_amount).toBe(1500);
    // exactly one PUT /deal/:applicationId is registered (the shadowed duplicate is gone)
    const puts = (brokerImportsRouter as any).stack.filter((l: any) => l.route?.path === "/deal/:applicationId" && l.route.methods.put);
    expect(puts).toHaveLength(1);
  });
});
