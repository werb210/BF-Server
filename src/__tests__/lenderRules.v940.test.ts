// BF_SERVER_v940_LENDER_PRODUCT_RULES - lender knock-out rules and commission terms on a product.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";
import { fundsUpTo, knockouts, parseCommissionTerms, parseMatchRules, type FileFigures } from "../lenderRules/rules.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock, dbQuery: queryMock, query: queryMock };
});

const file = (over: Partial<FileFigures> = {}): FileFigures => ({
  monthlyRevenue: 10000, monthlyRevenueBasis: "bank deposits", nsfPerMonth: 4, avgDailyBalance: 2500, positions: 2,
  monthsInBusiness: 30, requestedAmount: 50000, ...over,
});

beforeEach(() => { queryMock.mockReset(); });

describe("rules", () => {
  it("reads what the product form sends", () => {
    expect(parseMatchRules({ maxNsfPerMonth: "3", min_monthly_revenue: "$10,000", maxFundingMultiple: 1.5, maxPositions: "2", junk: 1 }))
      .toEqual({ max_nsf_per_month: 3, min_monthly_revenue: 10000, max_funding_multiple: 1.5, max_positions: 2 });
    expect(parseMatchRules(null)).toBeNull();
    expect(parseCommissionTerms({ kind: "profit_share", sharePercent: "12", shareMonths: 36, clawbackDays: 30 }))
      .toEqual({ kind: "profit_share", share_percent: 12, share_months: 36, clawback_days: 30 });
    expect(parseCommissionTerms({ kind: "bribe", percent: 2 })).toEqual({ kind: null, percent: 2 });
  });

  it("4 NSFs a month fails a lender that allows 3; an unknown figure never fails", () => {
    expect(knockouts({ max_nsf_per_month: 3 }, file())).toEqual(["4 NSFs a month on average; this lender allows 3"]);
    expect(knockouts({ max_nsf_per_month: 3 }, file({ nsfPerMonth: null }))).toEqual([]);
    expect(knockouts({}, file())).toEqual([]);
  });

  it("checks minimum monthly revenue, daily balance, positions and time in business", () => {
    const r = knockouts({ min_monthly_revenue: 15000, min_avg_daily_balance: 5000, max_positions: 1, min_months_in_business: 36 }, file());
    expect(r).toHaveLength(4);
    expect(r[0]).toContain("$10,000 (bank deposits)");
  });

  it("a lender funding 1.5x monthly revenue funds up to $15,000 on $10,000 a month", () => {
    expect(fundsUpTo({ max_funding_multiple: 1.5 }, file())).toBe(15000);
    expect(fundsUpTo({ max_funding_multiple: 2 }, file())).toBe(20000);
    expect(fundsUpTo({}, file())).toBeNull();
  });
});

describe("matching", () => {
  const product = (id: string, rules: Record<string, unknown>) => ({
    product_id: id, lender_id: "L" + id, lender_name: "Lender " + id, product_name: "Term " + id, product_category: "TERM",
    country: "BOTH", active: true, min_amount: null, max_amount: null, submission_method: "email", match_rules: rules,
  });

  it("hides the file from a lender whose rule it breaks, and says why", async () => {
    queryMock.mockImplementation(answerBySql([[/from lender_products lp/i, { rows: [product("1", { max_nsf_per_month: 3 }), product("2", { max_funding_multiple: 1.5 })] }]]));
    const { matchLendersDetailed } = await import("../ai/lenderMatchEngine.js");
    const r = await matchLendersDetailed({ requestedAmount: 50000, productCategory: "TERM" }, file());
    expect(r.matches.map((m) => m.id)).toEqual(["2"]);
    expect(r.matches[0]!.fundsUpTo).toBe(15000);
    expect(r.matches[0]!.reasoning).toContain("funds up to $15,000");
    expect(r.excluded).toEqual([{ id: "1", lenderName: "Lender 1", productName: "Term 1", reasons: ["4 NSFs a month on average; this lender allows 3"] }]);
  });

  it("without the file's figures nothing is hidden (older callers)", async () => {
    queryMock.mockImplementation(answerBySql([[/from lender_products lp/i, { rows: [product("1", { max_nsf_per_month: 3 })] }]]));
    const { matchLenders } = await import("../ai/lenderMatchEngine.js");
    expect((await matchLenders({ requestedAmount: 50000, productCategory: "TERM" })).map((m) => m.id)).toEqual(["1"]);
  });
});

describe("file figures", () => {
  it("uses bank deposits for monthly revenue when the banking analysis has run, else the application", async () => {
    const { loadFileFigures } = await import("../lenderRules/fileFigures.js");
    const q = (bank: unknown) => ({ query: async (sql: string) => (/FROM banking_analyses/.test(sql) ? { rows: bank ? [bank] : [] } : { rows: [] }) });
    const withBank = await loadFileFigures("A1", { requestedAmount: 1, revenue: 600000, timeInBusiness: 40, metadata: { kyc: { monthlyRevenue: 25000 } } },
      q({ total_avg_monthly_deposits: "26478", average_daily_balance: "1200", average_monthly_nsfs: "2.5" }));
    expect(withBank).toMatchObject({ monthlyRevenue: 26478, monthlyRevenueBasis: "bank deposits", nsfPerMonth: 2.5, avgDailyBalance: 1200, positions: null });
    const noBank = await loadFileFigures("A1", { requestedAmount: 1, revenue: 600000, timeInBusiness: 40, metadata: { kyc: { monthlyRevenue: 25000 } } }, q(null));
    expect(noBank).toMatchObject({ monthlyRevenue: 25000, monthlyRevenueBasis: "application", nsfPerMonth: null });
    const onlyAnnual = await loadFileFigures("A1", { requestedAmount: 1, revenue: 600000, timeInBusiness: 40, metadata: {} }, q(null));
    expect(onlyAnnual).toMatchObject({ monthlyRevenue: 50000, monthlyRevenueBasis: "annual revenue / 12" });
  });
});
