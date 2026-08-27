// BF_SERVER_SBA_FIELD_PARITY_v120
// Field names verified against the official templates with pypdf get_fields():
// 1919 (02/2025) 126 fields, 413 (05-24) 147, 912 (12/2028) 44.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SBA_1919_FIELDS as F19, SBA_413_FIELDS as F413, SBA_912_FIELDS as F12 } from "../fieldMaps.js";

const builder = readFileSync(resolve(__dirname, "..", "sbaFormBuilder.ts"), "utf-8");

describe("1919 printed question numbering", () => {
  it("maps printed n to internal qn for all thirteen", () => {
    for (let n = 1; n <= 13; n++) expect(F19.printedQuestion[n]).toEqual({ yes: `q${n}Yes`, no: `q${n}No` });
  });
  it("covers printed Q5 - it has a yes/no pair, above the export sales box", () => {
    expect(F19.printedQuestion[5]).toBeDefined();
    expect(builder).toContain("5: f.q5_exports");
  });
  it("reaches q13, which the pre-v120 shifted map never wrote", () => expect(F19.printedQuestion[13].yes).toBe("q13Yes"));
  it("no printed number is mapped to a lower internal number", () => {
    for (let n = 1; n <= 13; n++) expect(Number(F19.printedQuestion[n].yes.replace(/\D/g, ""))).toBe(n);
  });
});

describe("1919 second Other purpose row", () => {
  it("the form has two Other rows and both are written", () => {
    expect(F19.purposeOther2).toBe("purpOther2");
    expect(F19.purposeOther2Amt).toBe("otherAmt2");
    expect(builder).toContain("F19.purposeOther2Amt");
  });
});

describe("1919 fields present on the template but intentionally unwritten", () => {
  it("names the demographic block", () => {
    expect(F19.demoOwnerName).toBe("ownName");
    expect(F19.demoRaceNotDisclosed).toBe("raceND");
  });
  it("names the special ownership types", () => {
    expect(F19.specialOwnEsop).toBe("ownESOP");
    expect(F19.specialOwnOtherText).toBe("specOwnTypeOther");
  });
  it("does not write the /Sig fields", () => {
    expect(builder).not.toContain("F19.q4Initials");
    expect(builder).not.toContain("F19.repSignature");
  });
});

describe("413 Section 3 - stocks and bonds", () => {
  it("writes every column of a security row", () => {
    for (const f of ["stockShares", "stockName", "stockCost", "stockMarketValue", "stockQuoteDate", "stockTotalValue"]) expect(builder).toContain(`F413.${f}(i)`);
  });
  it("respects the four-row capacity of the paper form", () => {
    expect(F413.MAX_STOCK_ROWS).toBe(4);
    expect(builder).toContain("slice(0, F413.MAX_STOCK_ROWS)");
  });
});

describe("413 Section 4 - the six columns that were never written", () => {
  it.each(["propertyDatePurchased", "propertyOriginalCost", "propertyMortgageHolder", "propertyMortgageAccount", "propertyPayment", "propertyMortgageStatus"])("%s is written", (f) => {
    expect(builder).toContain(`F413.${f}(letter)`);
  });
  it("keeps the two spaces in the mortgage holder field name", () => expect(F413.propertyMortgageHolder("A")).toBe("Property AName  Address of Mortgage Holder"));
});

describe("912 initials are /Tx and must stay unwritten", () => {
  it("numbering does not follow question order", () => {
    expect(F12.q8Initials).toContain("Initial20");
    expect(F12.q9Initials).toContain("Initial22");
    expect(F12.q10Initials).toContain("Initial21");
  });
  it("the builder never types into them", () => {
    for (const f of ["q8Initials", "q9Initials", "q10Initials", "sbaOffice", "loanNumber"]) expect(builder).not.toContain(`F12.${f}`);
  });
});
