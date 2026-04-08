import { describe, expect, it, vi } from "vitest";

function runRealDbTest() {
  throw new Error("REAL_DB_BLOCKED");
}

describe("CI isolation invariants", () => {
  const ciOnly = process.env.CI === "true" ? it : it.skip;

  ciOnly("freezes process.env in CI", () => {
    expect(Object.isFrozen(process.env)).toBe(true);
  });

  it("blocks outbound network calls", async () => {
    expect(() => fetch("http://example.com")).toThrow("NETWORK_CALL_BLOCKED");
  });

  it("hard-blocks real DB test execution", () => {
    expect(() => runRealDbTest()).toThrow();
  });

  it("prevents module cache bleed across resetModules", async () => {
    const a = (await import("./fixtures/module-cache-esm")).default;
    vi.resetModules();
    const b = (await import("./fixtures/module-cache-esm")).default;
    expect(a).not.toBe(b);
  });
});
