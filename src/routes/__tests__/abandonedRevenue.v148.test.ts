// BF_SERVER_ABANDONED_REVENUE_v148
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const marketing = readFileSync(resolve(__dirname, "..", "marketing.ts"), "utf-8");
const step1 = "values.monthlyRevenue === \"Under $10,000\" && countryCode === \"CA\"";

describe("the answer that stopped them is returned", () => {
  it("selects monthlyRevenue from the kyc slice", () => {
    expect(marketing).toContain("a.metadata->'kyc'->>'monthlyRevenue'");
  });

  it("exposes it on each row", () => {
    expect(marketing).toContain("monthlyRevenue: r.kyc_monthly_revenue ?? null");
  });
});

describe("a hard stop is distinguished from an abandonment", () => {
  it("flags the Canadian floor", () => {
    expect(marketing).toContain("belowCanadianFloor");
    expect(marketing).toContain('String(revenue ?? "").trim() === "Under $10,000"');
  });

  it("matches the threshold the wizard enforces", () => {
    // The client gates Continue on exactly this pair; the two must agree or the
    // list will describe a different population than the one being blocked.
    expect(step1).toContain("Under $10,000");
    expect(marketing).toContain('country === "CA" &&');
  });

  it("requires both facts, so a null country never marks someone unfundable", () => {
    const i = marketing.indexOf("const isBelowCanadianFloor");
    const fn = marketing.slice(i, marketing.indexOf(";", marketing.indexOf("=>", i)));
    expect(fn).toContain('country === "CA"');
    expect(fn).toContain("&&");
    expect(fn).not.toContain("||");
  });

  it("counts what is actually callable", () => {
    expect(marketing).toContain("callable: items.length - belowFloor");
  });
});
