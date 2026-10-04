// BF_SERVER_DASHBOARD_MONEY_ADMIN_v733
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
describe("dashboard metrics hide commission from non-Admin staff", () => {
  it("only Admin gets the commission fields", () => {
    const s = readFileSync("src/routes/dashboard.ts", "utf8");
    expect(s).toContain('const isAdmin = String(req.user?.role ?? "").toLowerCase() === "admin";');
    expect(s).toContain("commissionEarned: isAdmin ? commissionEarned : undefined,");
    expect(s).toContain("commissionByStage: isAdmin ? commissionByStage : {},");
  });
});
