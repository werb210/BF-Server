// BF_SERVER_v65_CRM_DEDUP_EMAIL
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("BF_SERVER_v65_CRM_DEDUP_EMAIL", () => {
  const src = readFileSync(join(__dirname, "..", "services", "applicationCrmMirror.ts"), "utf8");
  it("anchor present", () => { expect(src.includes("BF_SERVER_v65_CRM_DEDUP_EMAIL")).toBe(true); });
  it("phone-miss falls back to email lookup before INSERT", () => {
    expect(src).toMatch(/let existing = await pool\.query/);
    expect(src).toMatch(/if \(!existing\.rows\[0\] && applicantPhone && applicantEmail\)/);
    expect(src).toMatch(/lower\(email\) = lower\(\$2\)/);
  });
});
