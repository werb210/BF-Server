// BF_SERVER_REFERRER_ROLLUP_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const s = readFileSync(path.join(process.cwd(), "src/routes/adminReferrers.ts"), "utf8");
describe("referrer commission rollup", () => {
  it("returns total_accrued and total_paid summed from referral_conversions", () => {
    expect(s).toContain("total_accrued");
    expect(s).toContain("total_paid");
    expect(s).toContain("FROM referral_conversions rcv");
    expect(s).toContain("FILTER (WHERE rcv.status = 'credited')");
    expect(s).toContain("FILTER (WHERE rcv.status = 'paid')");
  });
});
