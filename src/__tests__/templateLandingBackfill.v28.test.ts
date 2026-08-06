// BF_SERVER_TEMPLATE_LANDING_BACKFILL_v28
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isAbsoluteHttpUrl, needsLandingBackfill, type TemplateRow } from "../startup/templateLandingBackfill.js";

const row = (over: Partial<TemplateRow>): TemplateRow => ({
  id: "t1", silo: "BF", name: "Aug 6th - Lenders", subject: "s",
  html: null, link_url: null, fields: { headline: "h", body: "b" }, ...over,
});

describe("isAbsoluteHttpUrl", () => {
  it("rejects the setting-name-as-value case that produced the broken links", () => {
    expect(isAbsoluteHttpUrl("LANDING_BASE_URL/e/ftvf9n1dwg")).toBe(false);
  });
  it("rejects empty and null", () => {
    expect(isAbsoluteHttpUrl("")).toBe(false);
    expect(isAbsoluteHttpUrl(null)).toBe(false);
  });
  it("accepts a real base", () => {
    expect(isAbsoluteHttpUrl("https://www.boreal.financial/e/abc123")).toBe(true);
  });
});

describe("needsLandingBackfill", () => {
  it("flags a seeded row with fields but no html and no url", () => {
    expect(needsLandingBackfill(row({}))).toBe(true);
  });
  it("flags a saved row whose url carries the literal setting name", () => {
    expect(needsLandingBackfill(row({ html: "<p>x</p>", link_url: "LANDING_BASE_URL/e/ftvf9n1dwg" }))).toBe(true);
  });
  it("leaves a healthy row alone", () => {
    expect(needsLandingBackfill(row({ html: "<p>x</p>", link_url: "https://www.boreal.financial/e/abc123" }))).toBe(false);
  });
  it("ignores an empty row with neither fields nor html", () => {
    expect(needsLandingBackfill(row({ fields: null, html: null }))).toBe(false);
  });
});

describe("wiring", () => {
  it("rebuilds landingUrl on the template read path, not just on save", () => {
    const src = readFileSync("src/routes/marketing.ts", "utf8");
    expect(src).toContain("BF_SERVER_TEMPLATE_LANDING_BACKFILL_v28");
    expect(src).toContain("slug ? landingUrlForSlug(slug)");
  });
  it("runs the backfill at startup without being able to kill the process", () => {
    const src = readFileSync("src/index.ts", "utf8");
    expect(src).toContain("backfillTemplateLandingPages");
    expect(src).toContain("template_landing_backfill_error");
  });
});
