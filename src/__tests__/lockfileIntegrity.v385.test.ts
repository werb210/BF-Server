// BF_SERVER_LOCKFILE_INTEGRITY_v385 - every installed package in the lockfile
// carries a registry URL and integrity hash. A hand-edited lockfile (v379) had
// neither, named a ws release that does not exist, and broke `npm ci` in deploy.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const lock = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf8"));
const pkgs = lock.packages as Record<string, { link?: boolean; resolved?: string; integrity?: string; version?: string; dependencies?: Record<string, string> }>;

describe("package-lock.json is a real npm lockfile", () => {
  it("every package has resolved + integrity", () => {
    const missing = Object.entries(pkgs)
      .filter(([k, v]) => k !== "" && !v.link && (!v.resolved || !v.integrity))
      .map(([k]) => k);
    expect(missing).toEqual([]);
  });
  it("express-rate-limit accepts the patched ip-address", () => {
    const range = pkgs["node_modules/express-rate-limit"]?.dependencies?.["ip-address"] ?? "";
    expect(range.startsWith("^10.2")).toBe(true);
  });
});
