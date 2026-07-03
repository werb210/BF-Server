// BF_SERVER_PIPELINE_PLACEHOLDER_NAME_v1 + BF_SERVER_SUBMIT_NAME_FALLBACKS_v1
// A submitted application must never keep/render the 'Draft application'
// placeholder: submit resolves the business name from every payload shape,
// and the board SQL treats placeholders as absent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const submit = readFileSync(join(process.cwd(), "src", "routes", "client", "v1Applications.ts"), "utf-8");
const portal = readFileSync(join(process.cwd(), "src", "routes", "portal.ts"), "utf-8");
describe("placeholder application names", () => {
  it("submit falls back to business_info and normalized.company.name", () => {
    expect(submit).toContain("business_info?.companyName");
    expect(submit).toContain("normalizedBody?.company?.name");
  });
  it("pipeline board nulls out placeholder names", () => {
    expect(portal).toContain("NULLIF(NULLIF(NULLIF(a.name, ''), 'Draft application'), 'Untitled Application')");
  });
});
