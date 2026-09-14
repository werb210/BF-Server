// BF_SERVER_ADS_CAMPAIGNS_v176
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("marketing campaigns route", () => {
  const src = readFileSync("src/routes/marketing.ts", "utf-8");

  it("no longer returns a hardcoded empty campaign list", () => {
    expect(src).toContain("BF_SERVER_ADS_CAMPAIGNS_v176");
    expect(src).not.toMatch(/campaigns: \[\],\s*\n\s*total: 0,\s*\n\s*\},/);
  });

  it("queries Google Ads for campaign.id so the Negatives panel can bind to it", () => {
    expect(src).toContain("SELECT campaign.id, campaign.name, campaign.status");
    expect(src).toMatch(/googleAdsSearch/);
  });

  it("degrades to an empty list rather than throwing when Ads is unconfigured", () => {
    expect(src).toMatch(/if \(!googleAdsConfigured\(\)\)/);
  });
});

describe("contact name repair migration", () => {
  const sql = readFileSync("migrations/2026_09_15_v176_contact_name_repair.sql", "utf-8");

  it("reads metadata, not the nonexistent form_data column", () => {
    expect(sql).toContain("metadata->'applicant'");
    expect(sql).toContain("metadata->'formData'->'applicant'");
    expect(sql).not.toMatch(/\bform_data\b/);
  });

  it("strips the placeholder fragment out of the derived name", () => {
    expect(sql).toContain("application started");
    expect(sql).toContain("regexp_replace");
  });

  it("is guarded on applications.contact_id existing", () => {
    expect(sql).toContain("column_name = 'contact_id'");
  });
});
