// BF_SERVER_DASHBOARD_COMMISSION_v1 - the dashboard reports BF's projected
// commission per pipeline stage: 2% of the funded amount (accepted term sheet
// amount when present, else requested_amount) unless the product carries a
// commission override. commissionEarned is the Accepted bucket.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dash = readFileSync(join(process.cwd(), "src", "routes", "dashboard.ts"), "utf-8");

describe("dashboard BF commission", () => {
  it("no longer hardcodes commissionEarned to 0", () => {
    expect(dash).not.toContain("commissionEarned: 0");
    expect(dash).toContain("const commissionEarned = commissionByStage[\"Accepted\"] ?? 0;");
  });
  it("uses the accepted offer amount, falling back to requested_amount", () => {
    expect(dash).toContain("BF_SERVER_DASHBOARD_COMMISSION_v1");
    expect(dash).toContain("COALESCE(off.amount, a.requested_amount, 0)");
    expect(dash).toContain("o.status = 'accepted'");
  });
  it("applies the product commission override, defaulting to 2 percent", () => {
    expect(dash).toContain("COALESCE(lp.commission, 2) / 100.0");
    expect(dash).toContain("lp.id = a.lender_product_id::text");
  });
  it("returns commissionByStage grouped by pipeline stage", () => {
    expect(dash).toContain("commissionByStage");
    expect(dash).toContain("GROUP BY 1");
  });
});
