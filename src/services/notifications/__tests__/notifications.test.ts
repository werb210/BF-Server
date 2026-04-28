// BF_NOTIFICATIONS_v50 — pure-function tests for diffMentions.
import { describe, it, expect } from "vitest";
import { diffMentions } from "../notifications.service.js";

describe("BF_NOTIFICATIONS_v50 diffMentions", () => {
  it("returns all newMentions when previous is empty (create case)", () => {
    expect(diffMentions(["u1", "u2", "u3"])).toEqual(["u1", "u2", "u3"]);
  });
  it("returns only new ids when some overlap (update case)", () => {
    expect(diffMentions(["u1", "u2", "u3"], ["u1", "u3"])).toEqual(["u2"]);
  });
  it("returns [] when newMentions is fully contained in previous", () => {
    expect(diffMentions(["u1"], ["u1", "u2"])).toEqual([]);
  });
  it("dedupes within newMentions", () => {
    expect(diffMentions(["u1", "u1", "u2"])).toEqual(["u1", "u2"]);
  });
  it("ignores empty/falsy entries", () => {
    expect(diffMentions(["u1", "", "u2"] as string[])).toEqual(["u1", "u2"]);
  });
});
