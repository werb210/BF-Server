// BF_LENDERS_TAB_FIX_v55_SERVER — verify amountMin/amountMax surface
// to the portal-consumed LenderMatch shape.
import { describe, it, expect, vi, beforeEach } from "vitest";

const runQueryMock = vi.fn();
vi.mock("../../db", () => ({ runQuery: runQueryMock }));

describe("BF_LENDERS_TAB_FIX_v55_SERVER LenderMatch shape", () => {
  beforeEach(() => {
    vi.resetModules();
    runQueryMock.mockReset();
  });

  it("returns amountMin and amountMax as first-class fields", async () => {
    runQueryMock.mockResolvedValueOnce({
      rows: [{
        product_id: "p-1",
        lender_id: "l-1",
        lender_name: "Acme",
        product_name: "Term Loan A",
        product_category: "TERM_LOAN",
        country: null,
        active: true,
        min_amount: 25000,
        max_amount: 250000,
        submission_method: "email",
      }],
    });
    const { matchLenders } = await import("../lenderMatchEngine");
    const matches = await matchLenders({
      country: "CA", requestedAmount: 100000,
      timeInBusiness: 36, revenue: 500000,
    } as any);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      lenderName: "Acme",
      productCategory: "TERM_LOAN",
      amountMin: 25000,
      amountMax: 250000,
    });
    expect(typeof matches[0].matchPercent).toBe("number");
  });

  it("amountMin/amountMax are null when product has no requirements", async () => {
    runQueryMock.mockResolvedValueOnce({
      rows: [{
        product_id: "p-2", lender_id: "l-2", lender_name: "Beta",
        product_name: "Open Line", product_category: "LINE_OF_CREDIT",
        country: null, active: true,
        min_amount: null, max_amount: null, submission_method: null,
      }],
    });
    const { matchLenders } = await import("../lenderMatchEngine");
    const matches = await matchLenders({ country: "CA" } as any);
    expect(matches[0].amountMin).toBeNull();
    expect(matches[0].amountMax).toBeNull();
  });
});
