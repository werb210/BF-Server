// BF_SERVER_LANDING_BASE_GUARD_v24
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.resolve(__dirname, "../services/landingPage.service.ts"), "utf8");

describe("LANDING_BASE_URL guard", () => {
  it("validates the value is an absolute http(s) URL, not merely non-empty", () => {
    expect(src).toContain("/^https?:\\/\\/[^\\s/]+/i.test(raw)");
  });

  it("no longer trusts a bare truthy value", () => {
    expect(src).not.toContain('process.env.LANDING_BASE_URL || "https://www.boreal.financial"');
  });

  it("logs the rejected value so a misconfiguration is visible", () => {
    expect(src).toContain("ignoring invalid LANDING_BASE_URL");
  });

  it("still falls back to www, since the apex cannot serve /e/*", () => {
    expect(src).toContain('return "https://www.boreal.financial";');
  });
});
