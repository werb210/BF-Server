// BF_SERVER_REPORT_CURRENCY_v387
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dash = readFileSync(path.join(process.cwd(), "src/routes/dashboard.ts"), "utf8");

describe("reports keep CAD and USD apart", () => {
  it("commission and marketing revenue share one deal-currency rule", () => {
    expect(dash.match(/\$\{DEAL_CURRENCY_SQL\} AS currency/g)?.length).toBe(2);
    expect(dash).toContain("const DEAL_CURRENCY_SQL = `(CASE");
  });
  it("marketing revenue returns native CAD and USD beside the CAD total", () => {
    expect(dash).toContain("COALESCE(SUM(x.native) FILTER (WHERE x.currency = 'CAD'), 0)::text AS revenue_cad");
    expect(dash).toContain("COALESCE(SUM(x.native) FILTER (WHERE x.currency = 'USD'), 0)::text AS revenue_usd");
    expect(dash).toContain("revenueByCurrency: Object.fromEntries(");
    expect(dash).toContain("LEFT JOIN lender_products lp ON lp.id = a.lender_product_id::text");
  });
});
