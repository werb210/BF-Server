// BF_SERVER_BLOCK_v85_MULTI_LEG_SUBMIT_v1
import { describe, expect, it } from "vitest";

function companionFor(equipmentAmount: number) {
  const amount = Math.round(equipmentAmount * 0.2);
  return { amount, category: amount <= 50_000 ? "TERM" : "LOC" };
}

describe("v85 closing-costs companion routing", () => {
  it("$200k → $40k TERM", () => {
    expect(companionFor(200_000)).toEqual({ amount: 40_000, category: "TERM" });
  });
  it("$250k boundary → $50k TERM (≤)", () => {
    expect(companionFor(250_000)).toEqual({ amount: 50_000, category: "TERM" });
  });
  it("$251k just over → $50,200 LOC", () => {
    expect(companionFor(251_000)).toEqual({ amount: 50_200, category: "LOC" });
  });
  it("$300k → $60k LOC", () => {
    expect(companionFor(300_000)).toEqual({ amount: 60_000, category: "LOC" });
  });
});

describe("v85 capital&equipment leg detection", () => {
  function detectFanOut(input: Record<string, any>) {
    const lf = String(
      input.looking_for ?? input.lookingFor ?? input.kyc?.lookingFor ?? ""
    ).toUpperCase();
    return lf === "BOTH" || lf === "CAPITAL_AND_EQUIPMENT";
  }
  it("BOTH triggers fan-out", () => {
    expect(detectFanOut({ looking_for: "BOTH" })).toBe(true);
    expect(detectFanOut({ lookingFor: "BOTH" })).toBe(true);
    expect(detectFanOut({ kyc: { lookingFor: "BOTH" } })).toBe(true);
  });
  it("EQUIPMENT does not trigger fan-out", () => {
    expect(detectFanOut({ looking_for: "EQUIPMENT" })).toBe(false);
  });
  it("WORKING_CAPITAL does not trigger fan-out", () => {
    expect(detectFanOut({ looking_for: "WORKING_CAPITAL" })).toBe(false);
  });
});
