// BF_SERVER_BLOCK_v454_ADS_API_VERSION
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { GOOGLE_ADS_API_VERSION } from "../services/googleAdsService.js";

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : tsFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

describe("v454 one Google Ads API version", () => {
  it("is a current version", () => {
    expect(Number(GOOGLE_ADS_API_VERSION.replace("v", ""))).toBeGreaterThanOrEqual(21);
  });

  it("every Google Ads caller in src uses it", () => {
    const stale: string[] = [];
    for (const file of tsFiles("src")) {
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(/googleads\.googleapis\.com\/(v\d+)/g)) {
        if (m[1] !== GOOGLE_ADS_API_VERSION) stale.push(`${file}: ${m[1]}`);
      }
      for (const m of src.matchAll(/const API_VERSION = "(v\d+)"/g)) {
        if (m[1] !== GOOGLE_ADS_API_VERSION && /google/i.test(src)) stale.push(`${file}: API_VERSION ${m[1]}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("negatives no longer pins its own version", () => {
    const src = fs.readFileSync("src/services/googleAdsNegatives.ts", "utf8");
    expect(src).toContain("const API_VERSION = GOOGLE_ADS_API_VERSION;");
    expect(src).not.toContain('"v18"');
  });
});
