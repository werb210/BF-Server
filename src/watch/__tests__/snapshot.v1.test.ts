// BF_SERVER_WATCH_SNAPSHOT_v1
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const route = fs.readFileSync(path.resolve(__dirname, "../snapshotRoutes.ts"), "utf8");

describe("watch complication snapshot", () => {
  it("is authenticated", () => {
    expect(route).toContain("router.use(requireAuth)");
  });

  it("returns both values the widget provider reads", () => {
    // WatchWidget/BorealWatchWidget.swift reads presence.status and calls.missed.
    expect(route).toContain("status:");
    expect(route).toContain("missedCalls:");
  });

  it("counts missed calls for today only", () => {
    // An all-time running total on a complication is noise, not information.
    expect(route).toContain("date_trunc('day', now())");
  });

  it("degrades to a usable default rather than erroring", () => {
    // A complication that fails to refresh should show 'away', not break.
    expect(route).toContain('presence.rows[0]?.status ?? "away"');
    expect(route).toContain('.catch(() =>');
  });

  it("scopes both queries to the calling user", () => {
    expect(route.match(/WHERE user_id = \$1/g)?.length).toBe(2);
  });
});
