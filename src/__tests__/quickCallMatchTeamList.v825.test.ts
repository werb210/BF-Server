// BF_SERVER_BLOCK_v825_QUICKCALL_MATCH_TEAM_LIST regression coverage
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const telephonyRoutes = readFileSync("src/telephony/routes/telephonyRoutes.ts", "utf8");
const teamService = readFileSync("src/services/team/team.service.ts", "utf8");

const quickCallStart = telephonyRoutes.indexOf('router.get("/quick-call"');
const quickCallEnd = telephonyRoutes.indexOf('router.put("/quick-call"', quickCallStart);
const quickCallBlock = telephonyRoutes.slice(quickCallStart, quickCallEnd);

describe("v825 quick-call staff filter", () => {
  it("keeps the v825 quick-call/team-list alignment marker", () => {
    expect(quickCallBlock).toContain("BF_SERVER_BLOCK_v825_QUICKCALL_MATCH_TEAM_LIST");
  });

  it("uses the same active, deletion, and internal-role filter as listStaffUsers", () => {
    const sharedPredicates = [
      "COALESCE(is_active, true) = true",
      "deleted_at IS NULL",
      "role IN ('Admin', 'Staff', 'Ops', 'Marketing')",
    ];

    for (const predicate of sharedPredicates) {
      const quickCallPredicate = predicate
        .replaceAll("role", "u.role")
        .replace("COALESCE(is_active", "COALESCE(u.is_active")
        .replace("deleted_at", "u.deleted_at");

      expect(quickCallBlock).toContain(quickCallPredicate);
      expect(teamService).toContain(predicate);
    }
  });

  it("does not gate quick-call results on legacy active or disabled predicates", () => {
    expect(quickCallBlock).not.toMatch(/coalesce\(u\.active/i);
    expect(quickCallBlock).not.toMatch(/coalesce\(u\.disabled/i);
  });
});
