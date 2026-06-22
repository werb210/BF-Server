import { describe, it, expect } from "vitest";
import { accordGroupNeedsRefresh } from "../embeddedSigningSession.js";

describe("accordGroupNeedsRefresh", () => {
  it("regenerates when Accord is finalized but the cached group has only the Boreal doc", () => {
    expect(accordGroupNeedsRefresh(true, 1)).toBe(true);
    expect(accordGroupNeedsRefresh(true, 0)).toBe(true);
  });
  it("does NOT regenerate when the cached group already has the Accord doc", () => {
    expect(accordGroupNeedsRefresh(true, 2)).toBe(false);
    expect(accordGroupNeedsRefresh(true, 3)).toBe(false);
  });
  it("does NOT regenerate when Accord is not finalized (no Accord form expected)", () => {
    expect(accordGroupNeedsRefresh(false, 1)).toBe(false);
    expect(accordGroupNeedsRefresh(false, 0)).toBe(false);
  });
});
