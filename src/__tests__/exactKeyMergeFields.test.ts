import { describe, expect, it } from "vitest";
import { matchFields } from "../licenseeDocs/match.js";

describe("a Word merge field named exactly as a data key", () => {
  it("maps to that key, not to the nearest words", async () => {
    const m = await matchFields([
      { name: "offer.proceeds_fee", label: "Offer proceeds fee", type: "text" },
      { name: "offer.amount", label: "Offer amount", type: "text" },
      { name: "BrokerFee", label: "Broker fee", type: "text" },
    ], null);
    expect(m.map((f) => f.mapped_to)).toEqual(["offer.proceeds_fee", "offer.amount", "fee.amount"]);
  });
});
