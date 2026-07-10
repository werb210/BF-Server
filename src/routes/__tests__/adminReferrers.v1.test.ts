// BF_SERVER_ADMIN_REFERRERS_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const r = readFileSync(path.join(process.cwd(),"src/routes/adminReferrers.ts"),"utf8");
const reg = readFileSync(path.join(process.cwd(),"src/routes/routeRegistry.ts"),"utf8");
describe("admin referrers (v1)", () => {
  it("lists BF referrers with rollups, staff-gated", () => {
    expect(r).toContain("u.role = 'Referrer'");
    expect(r).toContain("referrals_count");
    expect(r).toContain("requireAuthorization");
  });
  it("is mounted at /admin/referrers", () => {
    expect(reg).toContain('path: "/admin/referrers"');
  });
});
