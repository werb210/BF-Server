// BF_SERVER_v887_LENDER_MATCH_FIX - every lender showed 71% and no funding range on the Lenders tab.
// 71% was the score with every input on its "unknown" default: no amount range (0.8 x 0.5), time in business not read
// (0.65 x 0.25) and revenue not read (0.6 x 0.25). These tests pin the real inputs and the real range.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: h.query }, runQuery: h.query, dbQuery: h.query }));

const product = (over: Record<string, unknown>) => ({
  product_id: "p", lender_id: "l", lender_name: "Northwind Capital", product_name: "Term A", product_category: "TERM",
  country: "BOTH", active: true, min_amount: null, max_amount: null, submission_method: "EMAIL", ...over,
});

beforeEach(() => { h.query.mockReset().mockImplementation(answerBySql([])); });

describe("lender match engine (v887)", () => {
  it("reads the range the Lender product editor saves (amount_min/amount_max) before the older columns", async () => {
    h.query.mockImplementation(answerBySql([[/from lender_products lp/i, { rows: [] }]]));
    const { matchLenders } = await import("../lenderMatchEngine.js");
    await matchLenders({ requestedAmount: 100_000 });
    const sql = String(callsMatching(h.query, /from lender_products lp/i)[0][0]);
    expect(sql).toContain("coalesce(lp.amount_min, lp.min_amount)  as min_amount");
    expect(sql).toContain("coalesce(lp.amount_max, lp.max_amount)  as max_amount");
  });

  it("lenders with different ranges get different scores, each with its own range and plain category words", async () => {
    h.query.mockImplementation(answerBySql([[/from lender_products lp/i, { rows: [
      product({ product_id: "p1", lender_name: "Northwind Capital", min_amount: "50000", max_amount: "150000" }),
      product({ product_id: "p2", lender_name: "Bluebird Funding", product_category: "LOC", min_amount: 10000, max_amount: 2000000 }),
      product({ product_id: "p3", lender_name: "Open Range Lending", product_category: "MCA" }),
    ] }]]));
    const { matchLenders, MATCH_VERSION } = await import("../lenderMatchEngine.js");
    const out = await matchLenders({ requestedAmount: 100_000, timeInBusiness: 36, revenue: 400_000 });
    const by = Object.fromEntries(out.map((m) => [m.id, m]));
    expect(by.p1).toMatchObject({ amountMin: 50000, amountMax: 150000, productCategoryLabel: "Term Loan", matchVersion: MATCH_VERSION });
    expect(by.p2).toMatchObject({ amountMin: 10000, amountMax: 2000000, productCategoryLabel: "Line of Credit" });
    expect(by.p3).toMatchObject({ amountMin: null, amountMax: null, productCategoryLabel: "Merchant Cash Advance" });
    expect(new Set(out.map((m) => m.matchPercent)).size).toBe(3);
    expect(out.some((m) => m.matchPercent === 71)).toBe(false);
    expect(by.p3.reasoning).toContain("No amount range on file");
    expect(by.p1.reasoning).toContain("36 months in business");
  });

  it("a saved maximum of 0 means no maximum, not $0", async () => {
    h.query.mockImplementation(answerBySql([[/from lender_products lp/i, { rows: [product({ min_amount: 5000, max_amount: 0 })] }]]));
    const { matchLenders } = await import("../lenderMatchEngine.js");
    const out = await matchLenders({ requestedAmount: 100_000 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ amountMin: 5000, amountMax: null });
  });
});

describe("match inputs read what the wizard saves (v887)", () => {
  it("revenue and time in business come from the kyc bands and the start date", async () => {
    const { extractMatchInputs } = await import("../../services/lenderMatchCache.js");
    const fromBands = extractMatchInputs({ requested_amount: 100000, product_category: "TERM_LOAN", metadata: { kyc: { annualRevenue: "$150,001 to $500,000", yearsInBusiness: "1 to 3 Years" } } });
    expect(fromBands.revenue).toBe(325001); // midpoint of the band
    expect(fromBands.timeInBusiness).toBe(24);
    const over = extractMatchInputs({ requested_amount: 1, product_category: "TERM", metadata: { kyc: { annualRevenue: "Over $3,000,000", yearsInBusiness: "Over 3 Years" } } });
    expect(over.revenue).toBe(3000000);
    expect(over.timeInBusiness).toBe(36);
    const under = extractMatchInputs({ requested_amount: 1, product_category: "TERM", metadata: { kyc: { yearsInBusiness: "Under 1 Year" } } });
    expect(under.timeInBusiness).toBe(6);
    const start = extractMatchInputs({ requested_amount: 1, product_category: "TERM", metadata: { business: { startDate: "2000-01-15" } } });
    expect(start.timeInBusiness).toBeGreaterThan(300);
  });
});

describe("cached lists from the old engine are recalculated (v887)", () => {
  it("a ready list without matchVersion is recomputed when the Lenders tab opens", async () => {
    h.query.mockImplementation(answerBySql([
      [/SELECT lender_matches, lender_matches_computed_at, lender_matches_stale/, { rows: [{
        lender_matches: [{ id: "old", lenderName: "Old Lender", matchPercent: 71, amountMin: null, amountMax: null }],
        lender_matches_computed_at: "2026-11-01T00:00:00Z", lender_matches_stale: false, lender_matches_inputs: null, lender_matches_missing_inputs: [],
      }] }],
      [/FROM application_required_documents/, { rows: [] }],
      [/SELECT id, metadata, requested_amount, product_category FROM applications/, { rows: [{ id: "app-1", requested_amount: 100000, product_category: "TERM_LOAN", metadata: {} }] }],
      [/from lender_products lp/i, { rows: [product({ product_id: "new", min_amount: 50000, max_amount: 150000 })] }],
    ]));
    const { readLenderMatchEnvelope } = await import("../../services/lenderMatchCache.js");
    const env = await readLenderMatchEnvelope("app-1");
    expect(env.status).toBe("ready");
    expect(env.matches.map((m: any) => m.id)).toEqual(["new"]);
    expect(env.matches[0]).toMatchObject({ amountMin: 50000, amountMax: 150000 });
  });

  it("a list already on the current engine is not recomputed", async () => {
    const { MATCH_VERSION } = await import("../lenderMatchEngine.js");
    h.query.mockImplementation(answerBySql([
      [/SELECT lender_matches, lender_matches_computed_at, lender_matches_stale/, { rows: [{
        lender_matches: [{ id: "cur", matchPercent: 64, matchVersion: MATCH_VERSION }],
        lender_matches_computed_at: "2026-11-04T00:00:00Z", lender_matches_stale: false, lender_matches_inputs: null, lender_matches_missing_inputs: [],
      }] }],
    ]));
    const { readLenderMatchEnvelope } = await import("../../services/lenderMatchCache.js");
    const env = await readLenderMatchEnvelope("app-2");
    expect(env.matches.map((m: any) => m.id)).toEqual(["cur"]);
    expect(callsMatching(h.query, /from lender_products lp/i)).toHaveLength(0);
  });
});

describe("product codes become words for staff (v887)", () => {
  it("every short and long code has a label", async () => {
    const { productCategoryLabel } = await import("../../modules/applications/productCategoryChange.js");
    expect(productCategoryLabel("TERM")).toBe("Term Loan");
    expect(productCategoryLabel("TERM_LOAN")).toBe("Term Loan");
    expect(productCategoryLabel("LOC")).toBe("Line of Credit");
    expect(productCategoryLabel("LINE_OF_CREDIT")).toBe("Line of Credit");
    expect(productCategoryLabel("MCA")).toBe("Merchant Cash Advance");
    expect(productCategoryLabel("po")).toBe("Purchase Order Finance");
    expect(productCategoryLabel("SOMETHING_NEW")).toBe("Something new");
    expect(productCategoryLabel(null)).toBe("");
  });

  it("the scorecard's lender-fit reason names the product type in words", async () => {
    const { rankProducts } = await import("../../brokerTools/scorecards.js");
    const out = rankProducts(
      [{ id: "p1", name: "Line A", category: "LOC", amount_min: 1000, amount_max: 500000 }],
      { product_category: "TERM_LOAN", requested_amount: 10000, metadata: {} },
      { score: null, grade: null, outcome: "clear", coverage: 0, factors: [], hits: [], missing: [], inputs: {} } as any,
      { factors: [], grades: [], rules: [], lender_min_grade: {} },
      new Set(),
    );
    expect(out[0].concerns).toContain("Product type is Line of Credit.");
    expect(out[0].concerns.join(" ")).not.toMatch(/\bLOC\b/);
  });
});
