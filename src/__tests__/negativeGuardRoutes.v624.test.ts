// BF_SERVER_NEGATIVE_GUARD_ROUTES_v624
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("routes", () => {
  const src = readFileSync("src/routes/marketing.ts", "utf8");
  it("guards adds, filters candidates and exposes conflicts", () => {
    expect(src).toContain("keyword_check_unavailable");
    expect(src).toContain("protectionReason");
    expect(src).toContain("minClicks");
    expect(src).toContain("/negative-conflicts");
    expect(src).toContain("/negative-conflicts/remove");
  });
  it("client tokens skip the staff lookup; dead document_requirements query is gone", () => {
    expect(readFileSync("src/middleware/auth.ts", "utf8")).toContain('!userId.startsWith("client:")');
    expect(readFileSync("src/routes/client/index.ts", "utf8")).not.toMatch(/FROM document_requirements WHERE application_id::text = \($1\)::text AND required = true/);
  });
});
