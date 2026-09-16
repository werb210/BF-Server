// BF_SERVER_CHANGE_PRODUCT_CATEGORY_v286
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { changeProductCategory, normalizeProductCategory, PRODUCT_CATEGORIES } from "../productCategoryChange.js";

describe("product category values", () => {
  it("accepts the match engine's buckets in any casing", () => {
    expect(normalizeProductCategory("term_loan")).toBe("TERM_LOAN");
    expect(normalizeProductCategory("Merchant Cash Advance")).toBe("MERCHANT_CASH_ADVANCE");
    expect(normalizeProductCategory("crypto")).toBeNull();
    expect(PRODUCT_CATEGORIES.map((c) => c.value)).toContain("LINE_OF_CREDIT");
  });
});

describe("changing the category", () => {
  it("sets the column, clears multi-category overrides, keeps history and marks matches stale", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ product_category: "MERCHANT_CASH_ADVANCE" }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const result = await changeProductCategory(query, "app-1", "TERM_LOAN", "user-1");
    expect(result).toEqual({ from: "MERCHANT_CASH_ADVANCE", to: "TERM_LOAN" });
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain("SET product_category = $2");
    expect(sql).toContain("- 'match_categories'");
    expect(sql).toContain("lender_matches_stale = true");
    expect(JSON.parse(String(params[2]))).toMatchObject({ from: "MERCHANT_CASH_ADVANCE", to: "TERM_LOAN", by: "user-1" });
  });
});

describe("wiring", () => {
  it("the route checks write permission and silo, then re-matches lenders", () => {
    const routes = fs.readFileSync("src/modules/applications/applications.routes.ts", "utf8");
    const route = routes.slice(routes.indexOf("router.post('/:id/product-category'"));
    expect(route).toContain("requireCapability([CAPABILITIES.CRM_WRITE])");
    expect(route.indexOf("app.silo !== silo")).toBeLessThan(route.indexOf("changeProductCategory("));
    expect(route.indexOf("computeAndCacheLenderMatches(appId)")).toBeGreaterThan(route.indexOf("changeProductCategory("));
  });
});
