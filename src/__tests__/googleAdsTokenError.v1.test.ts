// BF_SERVER_GOOGLE_ADS_TOKEN_ERROR_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const files = [
  "src/services/googleAdsService.ts",
  "src/services/googleAdsSuggestions.ts",
  "src/services/googleAdsConversions.ts",
];

describe("Google Ads token failures name their cause", () => {
  for (const f of files) {
    it(`${f} includes Google's response body in the error`, () => {
      const s = readFileSync(path.join(process.cwd(), f), "utf8");
      // A bare `status=400` is unactionable: five credentials feed this exchange and
      // Google's body says which one is wrong.
      expect(s).not.toMatch(/google_ads_token_failed status=\$\{r\.status\}`\);/);
      expect(s).toContain("r.text().catch");
    });
  }
});
