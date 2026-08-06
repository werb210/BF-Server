// BF_SERVER_TEST_SEND_REAL_CONTACT_v26
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.resolve(__dirname, "../routes/marketing.ts"), "utf8");

describe("test sends use the real contact", () => {
  it("no test path still hardcodes the placeholder name", () => {
    expect(src).not.toContain('{ first_name: "there", name: "there", email: b.test, company: "" }');
    expect(src).not.toContain('{ first_name: "there", name: "there", email: String(b.test), company: "" }');
  });

  it("all three test paths resolve vars from the CRM", () => {
    expect(src.match(/testSendVars\(silo, String\(b\.test\)/g)).toHaveLength(3);
  });

  it("matches an SMS test on the last 10 digits, so formatting cannot miss", () => {
    expect(src).toContain("right(regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g'), 10) = right($2, 10)");
  });

  it("scopes the lookup to the active silo", () => {
    expect(src).toContain("WHERE c.silo = $1 AND lower(c.email) = lower($2)");
  });

  it("still falls back to the placeholder when nothing matches", () => {
    expect(src).toContain('const fallback = { first_name: "there", name: "there"');
  });
});
