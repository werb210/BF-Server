import { describe, it, expect } from "vitest";
import { parseCallRef, callRefPredicate } from "../callRef.js";

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const SID = "CA" + "a1b2c3d4e5f60718293a4b5c6d7e8f90";

describe("BF_SERVER_CALL_REF_v161", () => {
  it("recognises our own call id", () => {
    expect(parseCallRef(UUID)).toEqual({ kind: "id", value: UUID });
  });

  it("recognises a Twilio call sid, which is all the dialer ever holds", () => {
    expect(parseCallRef(SID)).toEqual({ kind: "sid", value: SID });
  });

  it("is case-insensitive on both forms", () => {
    expect(parseCallRef(UUID.toUpperCase())?.kind).toBe("id");
    expect(parseCallRef(SID.toUpperCase())?.kind).toBe("sid");
  });

  it("trims surrounding whitespace", () => {
    expect(parseCallRef(`  ${SID}  `)?.value).toBe(SID);
  });

  it("rejects anything that is neither", () => {
    expect(parseCallRef("")).toBeNull();
    expect(parseCallRef(null)).toBeNull();
    expect(parseCallRef("not-an-id")).toBeNull();
    expect(parseCallRef("CA123")).toBeNull();
    // The old check was /^[0-9a-f-]{36}$/i, which let 36 hyphens through.
    expect(parseCallRef("-".repeat(36))).toBeNull();
  });

  it("rejects an sid of the wrong length", () => {
    expect(parseCallRef("CA" + "a".repeat(31))).toBeNull();
    expect(parseCallRef("CA" + "a".repeat(33))).toBeNull();
  });

  it("rejects a sid-shaped value with a different prefix", () => {
    expect(parseCallRef("SM" + "a".repeat(32))).toBeNull();
  });

  it("queries the matching column for each form", () => {
    expect(callRefPredicate({ kind: "id", value: UUID })).toBe("id = $2::uuid");
    expect(callRefPredicate({ kind: "sid", value: SID })).toBe("twilio_call_sid = $2");
  });

  it("never interpolates the value into SQL", () => {
    // The predicate is a fixed string per kind; the value always binds as $2.
    const predicate = callRefPredicate({ kind: "sid", value: "'; DROP TABLE call_logs;--" });
    expect(predicate).toBe("twilio_call_sid = $2");
    expect(predicate).not.toContain("DROP");
  });
});
