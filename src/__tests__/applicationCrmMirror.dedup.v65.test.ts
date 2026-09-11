// BF_SERVER_v65_CRM_DEDUP_EMAIL
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("BF_SERVER_v65_CRM_DEDUP_EMAIL", () => {
  const src = readFileSync(join(__dirname, "..", "services", "applicationCrmMirror.ts"), "utf8");
  it("keeps email deduplication after a phone miss", () => {
    expect(src).toContain("BF_SERVER_CRM_MIRROR_OTP_PHONE_AUTHORITATIVE_v1");
  });
  it("phone-miss falls back to email lookup before INSERT", () => {
    expect(src).toMatch(/let existing = await pool\.query/);
    expect(src).toMatch(/if \(!existing\.rows\[0\] && matchPhone && applicantEmail\)/);
    expect(src).toMatch(/lower\(email\) = lower\(\$2\)/);
  });
});
