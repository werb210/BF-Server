// The Close tab is filled in from the signed offer: the term in months is read from a term written as text, and the
// rate is shown without trailing zeros.
import { describe, expect, it } from "vitest";
import { monthsFromTerm, tidyRate } from "../deals/close.js";

describe("close prefill", () => {
  it("reads the months from the offer's term", () => {
    expect(monthsFromTerm("60 months")).toBe(60);
    expect(monthsFromTerm("5 years")).toBe(60);
    expect(monthsFromTerm("36")).toBe(36);
    expect(monthsFromTerm("18 mo")).toBe(18);
    expect(monthsFromTerm("until repaid")).toBeNull();
    expect(monthsFromTerm(null)).toBeNull();
    expect(monthsFromTerm("0")).toBeNull();
  });
  it("tidies the rate", () => {
    expect(tidyRate("9.5000")).toBe("9.5");
    expect(tidyRate("12.0000")).toBe("12");
    expect(tidyRate("1.30")).toBe("1.3");
    expect(tidyRate("Prime + 2")).toBe("Prime + 2");
    expect(tidyRate("")).toBeNull();
    expect(tidyRate(null)).toBeNull();
  });
});
