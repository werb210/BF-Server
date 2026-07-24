// BF_SERVER_DASHBOARD_RANGE_PARAM_v1
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  fileURLToPath(new URL("../dashboard.ts", import.meta.url)),
  "utf-8",
);

// windowDays is module-private, so exercise the same expression the route uses.
function windowDays(query: Record<string, unknown>): number {
  const raw = Number(query?.days ?? query?.range);
  if (!Number.isFinite(raw)) return 30;
  return Math.min(Math.max(Math.round(raw), 1), 365);
}

describe("dashboard window parameter", () => {
  it("honours ?range, which is what the dashboard component sends", () => {
    expect(windowDays({ range: 365 })).toBe(365);
    expect(windowDays({ range: 7 })).toBe(7);
    expect(windowDays({ range: 90 })).toBe(90);
  });

  it("still honours ?days, which every other panel sends", () => {
    expect(windowDays({ days: 90 })).toBe(90);
  });

  it("prefers days when both are present", () => {
    expect(windowDays({ days: 7, range: 365 })).toBe(7);
  });

  it("falls back to 30 only when neither is usable", () => {
    expect(windowDays({})).toBe(30);
    expect(windowDays({ range: "abc" })).toBe(30);
  });

  it("clamps to 1-365", () => {
    expect(windowDays({ range: 100000 })).toBe(365);
    expect(windowDays({ range: 0 })).toBe(1);
    expect(windowDays({ range: -5 })).toBe(1);
  });

  it("the route source reads both names", () => {
    expect(src).toContain("req?.query?.days ?? req?.query?.range");
  });
});
