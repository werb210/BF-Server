// BF_SERVER_REFERRALS_EXT_MOUNT_v1
import { describe, it, expect } from "vitest";
import { API_ROUTE_MOUNTS } from "../routeRegistry.js";
import referralsRoutes from "../referrals.js";
import referralsExtRoutes from "../referralsExt.js";

describe("referrals-ext mount", () => {
  it("mounts the ext router on its own path (no collision with /referrals)", () => {
    expect(API_ROUTE_MOUNTS.filter((m) => m.router === referralsExtRoutes).map((m) => m.path)).toEqual(["/referrals-ext"]);
  });

  it("does not double-mount referralsExtRoutes at /referrals", () => {
    const atReferrals = API_ROUTE_MOUNTS.filter((m) => m.path === "/referrals");
    expect(atReferrals.map((m) => m.router)).toEqual([referralsRoutes]);
    expect(atReferrals.some((m) => m.router === referralsExtRoutes)).toBe(false);
  });
});
