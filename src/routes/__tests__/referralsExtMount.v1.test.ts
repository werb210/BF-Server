// BF_SERVER_REFERRALS_EXT_MOUNT_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.join(process.cwd(), "src/routes/routeRegistry.ts"), "utf8");

describe("referrals-ext mount", () => {
  it("mounts the ext router on its own path (no collision with /referrals)", () => {
    expect(src).toContain('path: "/referrals-ext", router: referralsExtRoutes');
  });

  it("does not double-mount referralsExtRoutes at /referrals", () => {
    expect(src).not.toContain('path: "/referrals", router: referralsExtRoutes');
  });
});
