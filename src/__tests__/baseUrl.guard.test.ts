import { describe, it, expect, vi, beforeEach } from 'vitest';
describe("BASE_URL guard", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("throws when BASE_URL is missing in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.BASE_URL;
    await expect(import("../server")).rejects.toThrow("BASE_URL must be set in production.");
  });

  it("allows missing BASE_URL outside production", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.BASE_URL;
    await expect(import("../server")).resolves.toBeDefined();
  });
});
