// BF_SERVER_FUNNEL_EXCLUDE_BLANKS_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const s = readFileSync(path.join(process.cwd(), "src/routes/marketing.ts"), "utf8");
describe("funnel excludes empty-shell drafts v1", () => {
  it("excludes never-progressed Draft application rows", () => {
    expect(s).toContain("BF_SERVER_FUNNEL_EXCLUDE_BLANKS_v1");
    expect(s).toContain("name = 'Draft application'");
    expect(s).toContain("submitted_at IS NULL");
  });
});
