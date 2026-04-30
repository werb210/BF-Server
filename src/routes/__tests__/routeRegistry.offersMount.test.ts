// BF_SERVER_v77_BLOCK_1_11_OFFERS_COLLISION
import { describe, it, expect } from "vitest";
import { API_ROUTE_MOUNTS } from "../routeRegistry.js";
import { createApp } from "../../app.js";

describe("BF_SERVER_v77_BLOCK_1_11_OFFERS_COLLISION", () => {
  it("registers exactly one mount at /offers", () => {
    const offersMounts = API_ROUTE_MOUNTS.filter((m) => m.path === "/offers");
    expect(offersMounts.length).toBe(1);
  });

  it("createApp() does not throw a ROUTE COLLISION at boot", async () => {
    expect(() => createApp()).not.toThrow();
  });

  it("no path appears twice in API_ROUTE_MOUNTS", () => {
    const seen = new Map<string, number>();
    for (const m of API_ROUTE_MOUNTS) {
      seen.set(m.path, (seen.get(m.path) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    expect(dupes).toEqual([]);
  });
});
