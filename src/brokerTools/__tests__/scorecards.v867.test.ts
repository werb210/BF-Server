// BF_SERVER_v867_BROKER_TOOLS_SCORECARDS - factor values, scoring, grades, rule hits and lender ranking.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, firstNumber, inputsFrom, parseConfig, rankProducts, scoreInputs } from "../scorecards.js";

const app = { id: "a1", requested_amount: "150000", product_category: "EQUIPMENT_FINANCE",
  metadata: { kyc: { yearsInBusiness: "6 years", annualRevenue: "$1.2M" }, credit_bureau: { lowest_score: 702 } } };
const bank = { total_avg_monthly_deposits: "100000.00", average_daily_balance: "30000", average_monthly_nsfs: "0.33", negative_balance_days: 2,
  months_profitable_numerator: 5, months_profitable_denominator: 6 };

describe("credit scorecards", () => {
  it("reads numbers the way applications store them", () => {
    expect(firstNumber("$1,200,000")).toBe(1200000);
    expect(firstNumber("1.2M")).toBe(1200000);
    expect(firstNumber("250K")).toBe(250000);
    expect(firstNumber("1-2 years")).toBe(1);
    expect(firstNumber("none")).toBeNull();
  });

  it("builds the inputs from the application and its banking analysis", () => {
    expect(inputsFrom(app, bank)).toEqual({ years_in_business: 6, annual_revenue: 1200000, avg_monthly_deposits: 100000, average_daily_balance: 30000,
      nsf_per_month: 0.33, negative_days: 2, profitable_months_pct: 83, request_to_deposits: 1.5, credit_score: 702 });
    expect(inputsFrom({ metadata: { business: { startDate: "2024-11-01" } } }, null, new Date("2026-11-01T00:00:00Z")).years_in_business).toBe(2);
  });

  it("scores, grades and lists rule hits; missing data lowers coverage, not the score", () => {
    const r = scoreInputs(DEFAULT_CONFIG, inputsFrom(app, bank));
    expect(r.score).toBe(86); // 15x100 + 10x85 + 15x85 + 10x85 + 15x100 + 5x60 + 5x100 + 10x70 + 15x75, over 100
    expect(r).toMatchObject({ grade: "A", outcome: "clear", coverage: 100, hits: [] });
    const thin = scoreInputs(DEFAULT_CONFIG, { years_in_business: 0.5, credit_score: 480 });
    expect(thin.outcome).toBe("decline");
    expect(thin.hits.map((h) => h.id)).toEqual(["r2", "r3", "r4"]);
    expect(thin.coverage).toBe(30);
    expect(thin.missing).toContain("Average monthly deposits");
  });

  it("validates an Admin's config", () => {
    expect(parseConfig({ factors: [{ key: "credit_score", weight: 0, bands: [] }], grades: [{ grade: "A", min_score: 0 }] }).ok).toBe(false);
    expect(parseConfig({ factors: [{ key: "credit_score", weight: 120, bands: [] }], grades: [] })).toEqual({ ok: false, error: "Credit score (lowest principal): weight is 0 to 100." });
    const p = parseConfig({ ...DEFAULT_CONFIG, factors: [...DEFAULT_CONFIG.factors, { key: "made_up", weight: 5, bands: [] }], lender_min_grade: { p1: "b", "bad id!": "A" } });
    expect(p.ok && p.config.factors).toHaveLength(9);
    expect(p.ok && p.config.lender_min_grade).toEqual({ p1: "B" });
  });

  it("ranks lender products: fits first, each with its reasons and concerns", () => {
    const r = scoreInputs(DEFAULT_CONFIG, inputsFrom(app, bank));
    const products = [
      { id: "p1", name: "Equipment", category: "EQUIPMENT", amount_min: 20000, amount_max: 1500000, min_credit_score: 650, lender_name: "Stride" },
      { id: "p2", name: "Term loan", category: "TERM", amount_min: 10000, amount_max: 500000, lender_name: "Term Co" },
      { id: "p3", name: "Big equipment", category: "EQUIPMENT", amount_min: 1000000, amount_max: 20000000, lender_name: "Baker" },
      { id: "p4", name: "Equipment B", category: "EQUIPMENT", amount_min: 0, amount_max: 2000000, lender_name: "Choosy" },
    ];
    const ranked = rankProducts(products, app, r, { ...DEFAULT_CONFIG, lender_min_grade: { p4: "A" } }, new Set(["p4"]));
    expect(ranked.map((x) => x.lender_product_id)).toEqual(["p4", "p1", "p2", "p3"]);
    expect(ranked[1]!.reasons).toContain("Credit score meets 650.");
    expect(ranked[3]!.concerns).toContain("Amount is outside the product's range.");
  });
});
