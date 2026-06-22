import { describe, it, expect } from "vitest";
import { deriveSigningStatus } from "../applications.routes.js";

describe("deriveSigningStatus", () => {
  it("returns 'signed' when signedAt is set (highest precedence)", () => {
    expect(deriveSigningStatus({ signedAt: "2026-06-22T00:00:00Z", groupId: "g1", finalizedLenders: 1 })).toBe("signed");
  });
  it("returns 'started' when a group exists but not signed", () => {
    expect(deriveSigningStatus({ signedAt: null, groupId: "grp-123", finalizedLenders: 1 })).toBe("started");
  });
  it("returns 'ready' when a lender is finalized but no group yet", () => {
    expect(deriveSigningStatus({ signedAt: null, groupId: null, finalizedLenders: 1 })).toBe("ready");
  });
  it("returns 'not_started' when no lender is finalized", () => {
    expect(deriveSigningStatus({ signedAt: null, groupId: null, finalizedLenders: 0 })).toBe("not_started");
  });
});
