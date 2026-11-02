// BF_SERVER_v864_ACTIVE_CONTRACTS - the pure rules (balance estimate, renewal rules, engine decisions, revenue) and the
// route guards, against a database fake that answers by SQL content (not call order).
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: queryMock }, db: { query: queryMock }, runQuery: queryMock }));

import routes from "../../routes/activeContracts.js";
import { balanceView, effectiveRule, evaluate, parseRate, parseTermMonths, revenueSummary, normFrequency } from "../model.js";
import { patchToSql, renewalMetadata } from "../renewal.js";
import { clientSafe } from "../extras.js";
import { contractView } from "../repo.js";
import { normalizeExtracted } from "../statements.js";
import { defaultSplits } from "../money.js";

const NOW = new Date("2026-11-01T12:00:00Z");
const base = { id: "c1", status: "active", original_amount: 120000, funded_at: "2025-11-01", term_months: 24, payment_frequency: "monthly" };

describe("balance estimate", () => {
  it("straight-line over the term when there is no rate, labelled estimated", () => {
    const b = balanceView(base, null, NOW);
    expect(b.basis).toBe("estimated");
    expect(b.balance).toBe(60000);
    expect(b.percent_paid).toBe(50);
  });
  it("amortizes a loan with a rate", () => {
    const b = balanceView({ ...base, interest_rate: 12 }, null, NOW);
    expect(b.basis).toBe("estimated");
    expect(b.balance!).toBeGreaterThan(60000);
    expect(b.balance!).toBeLessThan(66000);
  });
  it("MCA: repayable = amount x factor; paid = payments x payment", () => {
    const b = balanceView({ ...base, product_category: "MCA", factor_rate: 1.3, payment_amount: 1000, payment_frequency: "weekly", term_months: null }, null, NOW);
    expect(b.total_repayable).toBe(156000);
    expect(b.balance).toBe(156000 - 52 * 1000);
  });
  it("a reported balance wins and keeps its source and date", () => {
    const b = balanceView(base, { balance: 70000, as_of: "2026-10-15", source: "lender_statement" }, NOW);
    expect(b).toMatchObject({ basis: "reported", source: "lender_statement", as_of: "2026-10-15", balance: 70000 });
  });
});

describe("renewal rules", () => {
  it("contract override > lender product rule > default by product", () => {
    expect(effectiveRule({ ...base, renewal_rule: { rule_type: "not_renewable" } }, { rule_type: "manual" }).source).toBe("contract");
    expect(effectiveRule(base, { rule_type: "percent_paid", percent_threshold: 60 })).toMatchObject({ source: "product", percent_threshold: 60 });
    expect(effectiveRule({ ...base, product_category: "MCA" }, null)).toMatchObject({ rule_type: "percent_paid", percent_threshold: 50, source: "default" });
    expect(effectiveRule({ ...base, product_category: "TERM" }, null)).toMatchObject({ rule_type: "months_before_maturity", source: "default" });
    expect(effectiveRule({ ...base, product_category: "LOC", term_months: null }, null).rule_type).toBe("manual");
  });
  it("percent paid: approaching -> upcoming, reached -> eligible", () => {
    const rule = { rule_type: "percent_paid" as const, percent_threshold: 50, approach_points: 10 };
    expect(evaluate(base, rule, { ...balanceView(base, null, NOW), percent_paid: 45 }, NOW).eligibility).toBe("upcoming");
    const e = evaluate(base, rule, balanceView(base, null, NOW), NOW);
    expect(e.eligibility).toBe("eligible");
    expect(e.suggested_status).toBe("renewal_eligible");
  });
  it("maturity milestones 120/90/60/30/matured", () => {
    const rule = { rule_type: "months_before_maturity" as const, months_before_maturity: 1 };
    const at = (days: number) => evaluate({ ...base, maturity_date: new Date(NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10) }, rule, balanceView(base, null, NOW), NOW);
    expect(at(110).maturity_milestone).toBe("d120");
    expect(at(110).suggested_status).toBe("renewal_upcoming");
    expect(at(85).maturity_milestone).toBe("d90");
    expect(at(45).maturity_milestone).toBe("d60");
    expect(at(20).maturity_milestone).toBe("d30");
    expect(at(20).eligibility).toBe("eligible");
    expect(at(-1).maturity_milestone).toBe("matured");
    expect(at(200).maturity_milestone).toBeNull();
  });
  it("never moves history or Default contracts", () => {
    const rule = { rule_type: "percent_paid" as const, percent_threshold: 10 };
    expect(evaluate({ ...base, status: "default" }, rule, balanceView(base, null, NOW), NOW).suggested_status).toBeNull();
    expect(evaluate({ ...base, status: "paid_out" }, rule, balanceView(base, null, NOW), NOW).suggested_status).toBeNull();
  });
  it("end-of-term prompts", () => {
    const rule = { rule_type: "manual" as const };
    expect(evaluate({ ...base, end_of_term_date: "2026-12-15" }, rule, balanceView(base, null, NOW), NOW).end_of_term_milestone).toBe("eot90");
    expect(evaluate({ ...base, end_of_term_date: "2026-11-20" }, rule, balanceView(base, null, NOW), NOW).end_of_term_milestone).toBe("eot30");
  });
});

describe("compensation", () => {
  it("expected is never revenue until a receipt is recorded; variance flagged", () => {
    const expected = [{ id: "e1", kind: "profit_share", due_on: "2026-10-15", expected_amount: 1250 }, { id: "e2", kind: "profit_share", due_on: "2026-11-15", expected_amount: 1250 }];
    const none = revenueSummary([], expected, NOW);
    expect(none.lifetime).toBe(0);
    expect(none.expected_future).toBe(1250);
    const ledger = [{ entry_type: "profit_share_payment", amount: 1190, is_revenue: true, effective_on: "2026-10-16", expected_payment_id: "e1" }];
    const r = revenueSummary(ledger, expected, NOW);
    expect(r.ytd).toBe(1190);
    expect(r.variances).toHaveLength(1);
    expect(r.variances[0]).toMatchObject({ id: "e1", variance: -60, status: "partial" });
  });
  it("a correction reverses the original; splits come off net revenue", () => {
    const ledger = [
      { id: "l1", entry_type: "commission_received", amount: 1000, is_revenue: true, broker_split_amount: 200, effective_on: "2026-11-01" },
      { id: "l2", entry_type: "correction", amount: -1000, is_revenue: true, broker_split_amount: -200, effective_on: "2026-11-01" },
      { id: "l3", entry_type: "clawback", amount: -100, is_revenue: true, effective_on: "2026-11-01" },
    ];
    expect(revenueSummary(ledger, [], NOW).lifetime).toBe(-100);
    expect(defaultSplits({ broker_split_percent: 20, referral_split_percent: 5 }, 1000)).toEqual({ broker: 200, referral: 50 });
  });
});

describe("parsing and pre-fill", () => {
  it("reads offer terms", () => {
    expect(parseTermMonths("24 months")).toBe(24);
    expect(parseTermMonths("2 years")).toBe(24);
    expect(parseRate("1.35")).toEqual({ interest_rate: null, factor_rate: 1.35 });
    expect(parseRate("9.5%")).toEqual({ interest_rate: 9.5, factor_rate: null });
    expect(normFrequency("Daily (Auto Debit)")).toBe("daily");
    expect(normFrequency("Bi-weekly")).toBe("biweekly");
  });
  it("renewal metadata copies unchanged facts, not amounts or signatures", () => {
    const meta = renewalMetadata({ kyc: { industry: "Ag", fundingAmount: 5, purposeOfFunds: "x" }, applicant: { firstName: "W" }, signnow_embedded: { a: 1 }, attribution: { g: 1 } },
      { id: "c1", product_category: "EQUIPMENT", lender_name: "RBC" }, "o1", "a1");
    expect(meta.kyc).toEqual({ industry: "Ag" });
    expect(meta.applicant).toEqual({ firstName: "W" });
    expect(meta.signnow_embedded).toBeUndefined();
    expect(meta.attribution).toBeUndefined();
    expect((meta.renewal as any).refresh_items.join(" ")).toMatch(/RBC.*equipment/s);
  });
  it("patch validation", () => {
    expect(patchToSql({ payment_amount: "1250", maturity_date: "2027-01-10", buyout_option: "fmv" }).sets).toHaveLength(3);
    expect(() => patchToSql({ payment_amount: "-1" })).toThrow();
    expect(() => patchToSql({ buyout_option: "maybe" })).toThrow();
    expect(() => patchToSql({ owner_user_id: "not-a-uuid" })).toThrow();
  });
  it("statement extraction is normalized", () => {
    expect(normalizeExtracted({ balance: "$72,000.50", as_of: "2026-10-01", payments_made: "130", borrower_name: " Clearbanc " }))
      .toMatchObject({ balance: 72000.5, as_of: "2026-10-01", payments_made: 130, borrower_name: "Clearbanc" });
  });
  it("the client view never carries commissions, notes or the ledger", () => {
    const v = contractView({ ...base, lender_name: "RBC", commission_terms: { upfront_percent: 2 }, internal_notes: "secret", commission_model: "upfront", owner_name: "Andrew" }, NOW);
    const safe = clientSafe(v) as Record<string, unknown>;
    const json = JSON.stringify(safe);
    expect(json).not.toMatch(/commission|secret|Andrew|internal/);
    expect(Object.keys(safe).sort()).toEqual(["actions", "approximate_maturity", "currency", "funding_date", "id", "lender", "original_amount", "product", "renewal", "status"]);
  });
});

const USER = "11111111-1111-4111-8111-111111111111";
const token = (claims: Record<string, unknown>) => jwt.sign({ tokenVersion: 0, tv: 0, ...claims }, String(process.env.JWT_SECRET));
function server() {
  const a = express();
  a.use(express.json());
  a.use("/api/active-contracts", routes);
  return a;
}
let settingsRow: Record<string, unknown> | null = null;
beforeEach(() => {
  settingsRow = null;
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM active_contract_settings WHERE silo/.test(sql)) return { rows: settingsRow ? [settingsRow] : [], rowCount: settingsRow ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  });
});

describe("routes", () => {
  it("staff routes need a staff token; settings changes need Admin", async () => {
    expect((await request(server()).get("/api/active-contracts")).status).toBe(401);
    const staff = token({ sub: USER, id: USER, role: "Staff" });
    expect((await request(server()).put("/api/active-contracts/settings").set("Authorization", `Bearer ${staff}`).send({ auto_email: true })).status).toBe(403);
    expect((await request(server()).get("/api/active-contracts/reports/portfolio").set("Authorization", `Bearer ${staff}`)).status).toBe(403);
    const list = await request(server()).get("/api/active-contracts").set("Authorization", `Bearer ${staff}`);
    expect(list.status).toBe(200);
    expect(list.body.summary).toMatchObject({ active_facilities: 0, revenue_ytd: 0 });
  });
  it("an unknown contract is 404, never another silo's", async () => {
    const staff = token({ sub: USER, id: USER, role: "Staff" });
    expect((await request(server()).get("/api/active-contracts/22222222-2222-4222-8222-222222222222").set("Authorization", `Bearer ${staff}`)).status).toBe(404);
  });
  it("the client view is off unless the flag AND the setting are on", async () => {
    const client = token({ sub: "client:5875550000", phone: "+15875550000", role: "client", isClient: true });
    delete process.env.ACTIVE_CONTRACTS_CLIENT_ENABLED;
    expect((await request(server()).get("/api/active-contracts/client/mine").set("Authorization", `Bearer ${client}`)).status).toBe(404);
    process.env.ACTIVE_CONTRACTS_CLIENT_ENABLED = "on";
    expect((await request(server()).get("/api/active-contracts/client/mine").set("Authorization", `Bearer ${client}`)).status).toBe(404);
    settingsRow = { silo: "BF", client_portal: true };
    const r = await request(server()).get("/api/active-contracts/client/mine").set("Authorization", `Bearer ${client}`);
    expect(r.status).toBe(200);
    expect(r.body.contracts).toEqual([]);
    expect((await request(server()).get("/api/active-contracts/client/mine")).status).toBe(401);
    delete process.env.ACTIVE_CONTRACTS_CLIENT_ENABLED;
  });
});
