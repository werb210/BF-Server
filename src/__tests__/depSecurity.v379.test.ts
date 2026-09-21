// BF_SERVER_DEPENDENCY_SECURITY_v379 - the lockfile carries patched versions of
// the packages the 2026-09-21 audit flagged as high severity in production.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const lock = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf8"));
const version = (name: string): number[] =>
  String(lock.packages?.[`node_modules/${name}`]?.version ?? "0.0.0").split(".").map((n) => parseInt(n, 10) || 0);
const atLeast = (name: string, min: number[]) => {
  const v = version(name);
  for (let i = 0; i < min.length; i += 1) {
    if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i];
  }
  return true;
};

describe("patched production dependencies", () => {
  it.each([
    ["ws", [8, 20, 2]],
    ["axios", [1, 17, 1]],
    ["form-data", [4, 0, 6]],
    ["body-parser", [1, 20, 6]],
    ["ip-address", [10, 3, 1]],
  ] as const)("%s is at or above its fixed release", (name, min) => {
    expect(atLeast(name, [...min])).toBe(true);
  });
});
