import { describe, it, expect } from "vitest";

describe("server bootstrap", () => {
  it("boots without crashing", async () => {
    const mod = await import("../src/index");
    expect(mod).toBeDefined();
  });
});
