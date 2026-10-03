// BF_SERVER_ONE_COMMISSION_v727
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("Reports and the Dashboard use one commission rule", () => {
  const d2 = readFileSync("src/services/reports/data2.ts", "utf8");
  const d1 = readFileSync("src/services/reports/data.ts", "utf8");
  it("the forecast uses the Dashboard's rate, amounts, currency conversion and stage scope", () => {
    expect(d2).toContain("(COALESCE(lp.commission, 2) / 100.0)");
    expect(d2).toContain("COALESCE(a.funded_amount, off.amount, a.requested_amount, 0)");
    expect(d2).toContain("FROM fx_rates WHERE currency = ${DEAL_CURRENCY_SQL}");
    expect(d2).toContain('${liveStageFilter("a.pipeline_state")}');
    expect(d2).not.toContain("commissionRate()");
    expect(d2).not.toContain('"Hold":');
  });
  it("commission by month uses the same rule", () => {
    const fn = d1.slice(d1.indexOf("export async function commissionByMonth("));
    expect(fn).toContain("(COALESCE(lp.commission, 2) / 100.0)");
    expect(fn).toContain("${DEAL_CURRENCY_SQL}");
  });
  it("the Dashboard's currency rule is shared, not copied", () => {
    expect(readFileSync("src/routes/dashboard.ts", "utf8")).toContain("export const DEAL_CURRENCY_SQL = `(CASE");
  });
});
