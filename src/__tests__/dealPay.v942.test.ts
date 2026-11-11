// BF_SERVER_v942_DEAL_CLOSE_REVENUE / BF_SERVER_v942_BROKER_PAY
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { buildStatement, commissionOn, payDateFor, payDatesBetween, windowFor, type PayLine, type PayPlan, type PaySettings } from "../deals/pay.js";
import { parseClose } from "../deals/close.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock, dbQuery: queryMock, query: queryMock };
});
vi.mock("../activeContracts/repo.js", () => ({ createContractFromApplication: vi.fn(async () => null) }));

const APP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BROKER = "00000000-0000-4000-8000-0000000000b1";
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const sign = (sub: string, role: string) => jwt.sign({ sub, id: sub, role, tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
async function app() {
  const deals = (await import("../routes/deals.js")).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const a = express(); a.use(express.json()); a.use("/api/deals", deals); a.use(errorHandler);
  return a;
}
beforeEach(() => { queryMock.mockReset(); });

const settings: PaySettings = { schedule: "semi_monthly", tier_basis: "revenue", tier_mode: "marginal" };
const plan = (over: Partial<PayPlan> = {}): PayPlan => ({
  user_id: BROKER, split_company_pct: 40, split_self_pct: 50, tiers: [], residual_share: true, base_monthly: 0, draw_monthly: 0,
  manager_user_id: null, override_pct: 0, active: true, starts_on: "2026-01-01", ...over,
});
const line = (over: Partial<PayLine> = {}): PayLine => ({
  id: "l1", close_id: "c1", application_id: APP, business: "Maple Ltd", kind: "lender_commission", status: "received",
  received_amount: 5000, received_on: "2026-11-05", clawed_back_on: null, broker_user_id: BROKER, lead_source: "company", referral_ratio: 0, ...over,
});

describe("pay schedule", () => {
  it("received 1st-15th is paid on the last day of the month; 16th-end on the 15th of the next", () => {
    expect(payDateFor("2026-11-05", "semi_monthly")).toBe("2026-11-30");
    expect(payDateFor("2026-11-15", "semi_monthly")).toBe("2026-11-30");
    expect(payDateFor("2026-11-16", "semi_monthly")).toBe("2026-12-15");
    expect(payDateFor("2026-12-20", "semi_monthly")).toBe("2027-01-15");
    expect(payDateFor("2026-02-10", "semi_monthly")).toBe("2026-02-28");
    expect(windowFor("2026-11-30", "semi_monthly")).toEqual({ from: "2026-11-01", to: "2026-11-15" });
    expect(windowFor("2026-12-15", "semi_monthly")).toEqual({ from: "2026-11-16", to: "2026-11-30" });
    expect(payDateFor("2026-11-20", "monthly")).toBe("2026-12-15");
    expect(payDatesBetween("2026-11-01", "2026-12-31", "semi_monthly")).toEqual(["2026-11-15", "2026-11-30", "2026-12-15", "2026-12-31"]);
  });
});

describe("tiers", () => {
  const tiered = plan({ tiers: [{ from: 0, pct: 40 }, { from: 10000, pct: 50 }] });
  it("marginal: 40% on the first $10,000, 50% above", () => {
    expect(commissionOn(15000, tiered, settings, 15000).amount).toBe(6500);
  });
  it("whole period: crossing $10,000 pays 50% on all of it", () => {
    expect(commissionOn(15000, tiered, { ...settings, tier_mode: "whole" }, 15000).amount).toBe(7500);
  });
});

describe("statements", () => {
  const base = { settings, plans: [plan()], closes: [], bonuses: [], adjustments: [], drawBalanceBefore: 0 };
  it("splits received revenue after the referral fee, more on a deal the broker found", () => {
    const st = buildStatement({ ...base, userId: BROKER, payDate: "2026-11-30", plan: plan(),
      lines: [line({ referral_ratio: 0.2 }), line({ id: "l2", lead_source: "self", received_amount: 1000 }), line({ id: "l3", received_on: "2026-11-20" }), line({ id: "l4", status: "expected", received_amount: null, received_on: null })] });
    // $5,000 less a 20% referral fee = $4,000 at 40% = $1,600; $1,000 self-sourced at 50% = $500; the 20th is next period
    expect(st.total).toBe(2100);
    expect(st.net_revenue).toBe(5000);
  });

  it("a residual pays while residual sharing is on; a clawback reverses what was paid", () => {
    const off = buildStatement({ ...base, userId: BROKER, payDate: "2026-11-30", plan: plan({ residual_share: false }), lines: [line({ kind: "residual", received_amount: 300 })] });
    expect(off.total).toBe(0);
    const claw = buildStatement({ ...base, userId: BROKER, payDate: "2026-11-30", plan: plan(), lines: [line({ status: "clawed_back", received_on: "2026-10-05", clawed_back_on: "2026-11-10" })] });
    expect(claw.lines.map((l) => l.kind)).toEqual(["clawback"]);
    expect(claw.total).toBe(-2000);
  });

  it("base pay, a draw recovered from commission, bonuses and a manager override", () => {
    const p = plan({ base_monthly: 2000, draw_monthly: 1000 });
    const first = buildStatement({ ...base, plans: [p], userId: BROKER, payDate: "2026-11-15", plan: p, lines: [] });
    expect(first.total).toBe(1500); // half-month base 1,000 + draw 500
    expect(first.draw_balance_after).toBe(500);
    const second = buildStatement({ ...base, plans: [p], userId: BROKER, payDate: "2026-11-30", plan: p, lines: [line()], drawBalanceBefore: 500,
      closes: [{ id: "c1", application_id: APP, business: "Maple Ltd", broker_user_id: BROKER, closed_on: "2026-11-03", funded_amount: 250000 }],
      bonuses: [{ id: "b1", name: "Funded deal bonus", kind: "per_deal", amount: 250, threshold: null, active: true }, { id: "b2", name: "Big month", kind: "volume_target", amount: 1000, threshold: 200000, active: true }] });
    // commission 2,000 - draw recovered 500 + new draw 500 + base 1,000 + 250 + 1,000
    expect(second.total).toBe(4250);
    const manager = buildStatement({ ...base, plans: [plan({ manager_user_id: OWNER, override_pct: 5 }), plan({ user_id: OWNER })], userId: OWNER, payDate: "2026-11-30", plan: plan({ user_id: OWNER }), lines: [line()] });
    expect(manager.lines.find((l) => l.kind === "override")?.amount).toBe(250);
  });
});

describe("close", () => {
  it("needs a date and an amount, and works out % lines on the funded amount", () => {
    expect(() => parseClose({ funded_amount: 1 })).toThrow("close date");
    const c = parseClose({ closed_on: "2026-11-11", funded_amount: "250,000", currency: "USD", lines: [{ kind: "lender_commission", basis: "percent", percent: 2 }, { kind: "referral_fee", amount: 1000 }] });
    expect(c.currency).toBe("USD");
    expect(c.lines[0]).toMatchObject({ basis: "percent", percent: 2, expected_amount: 5000 });
    expect(c.lines[1]).toMatchObject({ kind: "referral_fee", expected_amount: 1000 });
  });

  it("saving writes the close, its lines and the funded figures on the application", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SELECT silo, owner_user_id/, { rows: [{ silo: "BF", owner: BROKER }] }],
      [/INSERT INTO deal_closes/, { rows: [{ id: "c1" }] }],
      [/FROM deal_closes WHERE application_id/, { rows: [{ id: "c1", application_id: APP, closed_on: "2026-11-11", funded_amount: 250000 }] }],
      [/FROM deal_revenue_lines WHERE close_id/, { rows: [{ id: "l1", kind: "lender_commission", expected_amount: 5000, status: "expected" }] }],
    ]));
    const res = await request(await app()).put(`/api/deals/applications/${APP}/close`).set("Authorization", `Bearer ${sign(BROKER, "Staff")}`)
      .send({ closed_on: "2026-11-11", funded_amount: 250000, currency: "CAD", lines: [{ kind: "lender_commission", basis: "percent", percent: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body.close.id).toBe("c1");
    const upd = callsMatching(queryMock, /UPDATE applications SET funded_amount/)[0]!;
    expect(upd[1]).toEqual([APP, 250000, "CAD", "2026-11-11"]);
    expect(callsMatching(queryMock, /INSERT INTO deal_revenue_lines/)[0]![1]).toEqual(["c1", APP, "lender_commission", null, "percent", 2, 5000, null, null]);
  });
});

describe("revenue tab", () => {
  it("a broker sees only their own deals; an Admin sees everyone (or one broker)", async () => {
    queryMock.mockImplementation(answerBySql([[/FROM deal_closes c JOIN applications a/, { rows: [] }]]));
    const a = await app();
    await request(a).get("/api/deals/revenue?broker=someone-else").set("Authorization", `Bearer ${sign(BROKER, "Staff")}`);
    expect(callsMatching(queryMock, /FROM deal_closes c JOIN applications a/)[0]![1]![2]).toBe(BROKER);
    queryMock.mockClear();
    const all = await request(a).get("/api/deals/revenue").set("Authorization", `Bearer ${sign(OWNER, "Admin")}`);
    expect(all.body.scope).toBe("all");
    expect(callsMatching(queryMock, /FROM deal_closes c JOIN applications a/)[0]![1]![2]).toBeNull();
  });

  it("only an Admin sets broker pay", async () => {
    const res = await request(await app()).put(`/api/deals/pay-plans/${BROKER}`).set("Authorization", `Bearer ${sign(BROKER, "Staff")}`).send({ split_company_pct: 90 });
    expect(res.status).toBe(403);
  });
});
