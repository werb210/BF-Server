// BF_SERVER_BLOCK_v84_COMPANION_ROUTING_BY_AMOUNT_v1
import { describe, expect, it } from "vitest";

function companionFor(equipmentAmount: number) {
  const amount = Math.round(equipmentAmount * 0.2);
  return { amount, category: amount <= 50_000 ? "TERM" : "LOC" };
}

describe("v84 closing-costs companion routing by amount", () => {
  it("$200k equipment → $40k TERM", () => {
    expect(companionFor(200_000)).toEqual({ amount: 40_000, category: "TERM" });
  });
  it("$250k equipment → $50k TERM (boundary, ≤)", () => {
    expect(companionFor(250_000)).toEqual({ amount: 50_000, category: "TERM" });
  });
  it("$251k equipment → $50,200 LOC (just over)", () => {
    expect(companionFor(251_000)).toEqual({ amount: 50_200, category: "LOC" });
  });
  it("$300k equipment → $60k LOC", () => {
    expect(companionFor(300_000)).toEqual({ amount: 60_000, category: "LOC" });
  });
});
