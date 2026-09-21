// BF_SERVER_WATCH_SNAPSHOT_v1
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const route = fs.readFileSync(path.resolve(__dirname, "../snapshotRoutes.ts"), "utf8");

describe("watch complication snapshot", () => {
  it("is authenticated", () => {
    // v370: route-level, so the router can sit ahead of the Watch data routes.
    expect(route).toMatch(/router\.get\(\s*"\/snapshot",\s*requireAuth,/);
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
    // BF_SERVER_WATCH_PRESENCE_TABLE_v214 - this used to pin the literal
    // expression `presence.rows[0]?.status ?? "away"`. That fallback was not a
    // graceful degradation: the query beside it read a user_presence table that
    // does not exist, so "away" was the only value the endpoint ever returned.
    // Assert the behaviour instead of the wording.
    expect(route).toContain('.catch(() =>');
    expect(route).toMatch(/const status = !row \? "offline" : row\.stale \? "offline" : row\.status;/);
  });

  it("no longer defaults to a status the presence table cannot hold", () => {
    // staff_presence.status is CHECK (available|busy|offline). "away" was never
    // a real value - only the fallback of a query that always failed.
    expect(route).not.toContain('"away"');
  });

  it("scopes every query to the calling user", () => {
    // Was `.match(/WHERE user_id = $1/g)?.length === 2`, which kept passing
    // through three separate rewrites because $1::uuid still contains $1 - it
    // was counting substrings, not checking scope.
    const scoped = route.match(/WHERE\s+(?:assignee_)?user_id = \$1::uuid/g) ?? [];
    expect(scoped.length).toBe(3);
  });
});
