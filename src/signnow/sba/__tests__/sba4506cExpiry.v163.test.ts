// BF_SERVER_4506C_120_DAY_v163
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { is4506cExpired, daysSince, IRS_4506C_VALID_DAYS } from "../sbaSigning.js";

const signing = readFileSync(resolve(__dirname, "..", "sbaSigning.ts"), "utf-8");
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe("the IRS 120-day rule", () => {
  it("matches the instruction printed on the form", () => {
    expect(IRS_4506C_VALID_DAYS).toBe(120);
  });

  it("a fresh signature is fine", () => {
    expect(is4506cExpired(ago(0))).toBe(false);
    expect(is4506cExpired(ago(119))).toBe(false);
  });

  it("day 120 is still inside the window", () => {
    expect(is4506cExpired(ago(120))).toBe(false);
  });

  it("day 121 is not", () => {
    expect(is4506cExpired(ago(121))).toBe(true);
  });
});

describe("it never ages out something it cannot date", () => {
  it("an envelope from before v163 has no timestamp", () => {
    expect(is4506cExpired(undefined)).toBe(false);
    expect(is4506cExpired(null)).toBe(false);
  });

  it("an unparseable date is not treated as expired", () => {
    expect(is4506cExpired("not a date")).toBe(false);
    expect(daysSince("not a date")).toBeNull();
  });
});

describe("the gate", () => {
  it("blocks a stale authorisation", () => {
    expect(signing).toContain("sba_dispatch_blocked_4506c_expired");
    const i = signing.indexOf("sba_dispatch_blocked_4506c_expired");
    expect(signing.slice(i, i + 600)).toContain("return false;");
  });

  it("only when a 4506-C is actually in the envelope", () => {
    expect(signing).toContain("(envelope.ives4506cLenderIds?.length ?? 0) > 0 && is4506cExpired(envelope.createdAt)");
  });

  it("checks it after the signed check, not before", () => {
    // An unsigned envelope has a clearer failure; expiry only matters once signed.
    expect(signing.indexOf(".signed !== true")).toBeLessThan(signing.indexOf("is4506cExpired(envelope.createdAt)"));
  });

  it("says what to do about it", () => {
    expect(signing).toContain("Resend the SBA signing request from the SBA Signing tab");
  });

  it("records the timestamp when the envelope is made", () => {
    expect(signing).toContain("createdAt: new Date().toISOString()");
  });
});
