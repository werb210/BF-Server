// BF_SERVER_VISITOR_JOURNEY_MOUNT_FIX_v1
// _canonicalMount silently DROPS a duplicate mount path (keeps the first registration) so a
// bad registry entry cannot crash-loop prod. The trade-off is that a duplicate mount makes a
// whole router disappear with only a console warning - which is how the visitor-journey
// collector shipped unmounted at "/track" behind the email-pixel router. Guard the registry.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "src", "routes", "routeRegistry.ts"), "utf-8");

describe("route registry mounts", () => {
  it("has no duplicate mount paths", () => {
    const paths = [...source.matchAll(/\{\s*path:\s*"([^"]+)",\s*router:/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(10);
    const seen = new Map<string, number>();
    for (const p of paths) seen.set(p as string, (seen.get(p as string) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([p]) => p);
    expect(duplicates).toEqual([]);
  });

  it("keeps the visitor-journey collector on its own mount path", () => {
    expect(source).toContain('{ path: "/track/journey", router: visitorTrackRoutes }');
  });
});
