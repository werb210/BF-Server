// BF_SERVER_v68_OTP_HAS_SUBMISSION
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("BF_SERVER_v68_OTP_HAS_SUBMISSION", () => {
  const src = readFileSync(
    join(__dirname, "..", "routes", "auth.ts"),
    "utf8"
  );

  it("anchor present", () => {
    expect(src).toContain("BF_SERVER_v68_OTP_HAS_SUBMISSION");
  });

  it("imports dbQuery from lib/db", () => {
    expect(src).toMatch(/import\s*\{\s*runQuery as dbQuery_v68\s*\}\s*from\s*"\.\.\/lib\/db\.js"/);
  });

  it("OTP verify production response includes hasSubmittedApplication and submittedApplicationId", () => {
    const lookupIdx = src.indexOf("findAuthUserByPhone");
    expect(lookupIdx).toBeGreaterThan(-1);
    const block = src.slice(lookupIdx);
    expect(block).toContain("hasSubmittedApplication");
    expect(block).toContain("submittedApplicationId");
    expect(block).toMatch(/data:\s*\{\s*token,\s*hasSubmittedApplication,\s*submittedApplicationId\s*\}/);
  });

  it("submission lookup joins applications + application_contacts + contacts", () => {
    expect(src).toMatch(/FROM applications a/);
    expect(src).toMatch(/INNER JOIN application_contacts ac/);
    expect(src).toMatch(/INNER JOIN contacts c/);
    expect(src).toMatch(/a\.submitted_at IS NOT NULL/);
    expect(src).toMatch(/ac\.role = 'applicant'/);
    expect(src).toMatch(/c\.phone = \$1/);
  });

  it("submission lookup is wrapped in try/catch so OTP verify never fails on a DB hiccup", () => {
    const start = src.indexOf("submitted_at IS NOT NULL");
    expect(start).toBeGreaterThan(-1);
    const tryIdx = src.lastIndexOf("try {", start);
    expect(tryIdx).toBeGreaterThan(-1);
    const between = src.slice(tryIdx, src.indexOf("} catch", start));
    expect(between).toContain("submitted_at IS NOT NULL");
  });
});
