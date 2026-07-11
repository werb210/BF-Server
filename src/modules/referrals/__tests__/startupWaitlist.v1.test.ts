// BF_SERVER_STARTUP_WAITLIST_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const r = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
describe("startup waitlist", () => {
  it("startup referral is waitlisted (no intro; tagged)", () => {
    const s = r("src/modules/referrals/referrals.service.ts");
    expect(s).toContain("startup?: boolean");
    expect(s).toContain("ARRAY['startup_capital']::text[]");
    expect(s).toContain("if (effectiveSilos.length > 0)");
  });
  it("add-referral parses the startup flag", () => {
    expect(r("src/routes/referrerSelf.ts")).toContain("const startup = body.startup === true");
  });
  it("startup capital product create triggers the one-time blast", () => {
    const s = r("src/repositories/lenderProducts.repo.ts");
    expect(s).toContain('/startup/i.test(String(params.category ?? ""))');
    expect(s).toContain("notifyStartupWaitlistOnce");
  });
  it("service sends once + marks notified", () => {
    const s = r("src/modules/referrals/startupWaitlist.service.ts");
    expect(s).toContain("'startup_capital' = ANY");
    expect(s).toContain("ARRAY['startup_notified']::text[]");
  });
});
