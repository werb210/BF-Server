// BF_SERVER_FUNNEL_COUNT_STEP1_v79
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const s = readFileSync(path.join(process.cwd(), "src/routes/marketing.ts"), "utf8");

describe("funnel counts verified step-one abandoners v79", () => {
  it("keeps never-progressed application rows in the funnel", () => {
    expect(s).toContain("BF_SERVER_FUNNEL_COUNT_STEP1_v79");
    expect(s).not.toContain("BF_SERVER_FUNNEL_EXCLUDE_BLANKS_v1");
    expect(s).not.toContain("name = 'Draft application'");
  });
});
