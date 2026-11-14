// An unreadable saved key is reported once per start, not on every reload of the keys.
import { describe, expect, it } from "vitest";
import { firstUnreadable } from "../integrations/vendorKeys.js";

describe("unreadable saved keys", () => {
  it("are reported the first time only, per key", () => {
    expect(firstUnreadable("TEST_KEY_A")).toBe(true);
    expect(firstUnreadable("TEST_KEY_A")).toBe(false);
    expect(firstUnreadable("TEST_KEY_B")).toBe(true);
  });
});
