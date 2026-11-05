// BF_SERVER_v886_CREDIT_LIVE_TABLE - a credit summary (Nov 2026 review) had three columns for one period
// (FY2026 / Jan-Jul 2026 / January-July 2026) and gross margin equal to revenue.
import { describe, expect, it } from "vitest";
import { buildTable } from "../financials.js";

const cell = (period: string, kind: string, line_item: string, value: number) =>
  ({ period, period_end: "2026-07-31", kind, line_item, value, source_document_id: null, edited_by: null }) as any;

describe("one column per period", () => {
  it("merges the three labels for Jan-Jul 2026 and leaves gross margin blank", () => {
    const t = buildTable([
      cell("FY2026", "annual", "net_income", 450000), cell("FY2026", "annual", "equity", 1100000),
      cell("Jan-Jul 2026", "interim", "revenue", 1000000), cell("Jan-Jul 2026", "interim", "gross_margin", 1000000), cell("Jan-Jul 2026", "interim", "net_income", 450000),
      cell("January-July 2026", "interim", "revenue", 1000000), cell("January-July 2026", "interim", "net_income", 450000),
    ]);
    expect(t.periods).toHaveLength(1);
    expect(t.rows.find((r) => r.item === "revenue")?.values).toEqual([1000000]);
    expect(t.rows.find((r) => r.item === "gross_margin")).toBeUndefined();
  });
});
