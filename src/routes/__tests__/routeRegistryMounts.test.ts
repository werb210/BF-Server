// BF_SERVER_VISITOR_JOURNEY_MOUNT_FIX_v1
// _canonicalMount silently DROPS a duplicate mount path (keeps the first registration) so a
// bad registry entry cannot crash-loop prod. The trade-off is that a duplicate mount makes a
// whole router disappear with only a console warning - which is how the visitor-journey
// collector shipped unmounted at "/track" behind the email-pixel router. Guard the registry.
import { Router } from "express";
import { describe, expect, it, vi } from "vitest";
import { API_ROUTE_MOUNTS, registerApiRouteMounts } from "../routeRegistry.js";
import visitorTrackRoutes from "../visitorTrack.js";
import emailPixelRoutes from "../emailPixel.js";

describe("route registry mounts", () => {
  it("has no duplicate mount paths", () => {
    const paths = API_ROUTE_MOUNTS.map((m) => m.path);
    expect(paths.length).toBeGreaterThan(10);
    const seen = new Map<string, number>();
    for (const p of paths) seen.set(p, (seen.get(p) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([p]) => p);
    expect(duplicates).toEqual([]);
  });

  it("registering every mount drops nothing as a duplicate", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = Router();
    registerApiRouteMounts(app);
    expect(err.mock.calls.filter((c) => String(c[0]).includes("duplicate mount"))).toEqual([]);
    err.mockRestore();
  });

  it("keeps the visitor-journey collector on its own mount path", () => {
    expect(API_ROUTE_MOUNTS.find((m) => m.path === "/track/journey")?.router).toBe(visitorTrackRoutes);
    expect(API_ROUTE_MOUNTS.find((m) => m.path === "/track")?.router).toBe(emailPixelRoutes);
  });
});
