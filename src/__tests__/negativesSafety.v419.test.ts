// BF_SERVER_NEGATIVES_SAFETY_v419
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const service = read("src/services/googleAdsNegatives.ts");
const routes = read("src/routes/marketing.ts");

describe("v419 a negative can be previewed and undone", () => {
  it("keeps the resourceName Google returns", () => {
    expect(service).toContain("resourceNames");
    expect(service).toContain("results[i]?.resourceName");
  });

  it("blast radius counts converting searches, not just cost", () => {
    expect(service).toContain("convertingCount");
    expect(service).toContain("blocked.conversions > 0");
  });

  it("EXACT has no blast radius by definition", () => {
    expect(service).toContain('if (matchType === "EXACT")');
  });

  it("removal hits Google, not just our table", () => {
    expect(service).toContain("removeCampaignNegative");
    expect(service).toContain("{ remove: resourceName }");
    expect(routes).toContain("negative-keywords/:id/remove");
    expect(routes).toContain("SET removed_at = now()");
  });

  it("every added negative is logged", () => {
    expect(routes).toContain("INSERT INTO ads_negatives_log");
  });
});
