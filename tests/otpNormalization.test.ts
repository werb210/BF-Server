import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { normalizePhone } from "../src/utils/phone";

describe("phone normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("normalizes canadian number", () => {
    expect(normalizePhone("4035551234")).toBe("+14035551234");
  });

  it("accepts + format", () => {
    expect(normalizePhone("+14035551234")).toBe("+14035551234");
  });

  it("rejects invalid numbers", () => {
    expect(() => normalizePhone("555")).toThrow("Invalid phone number format");
  });
});
