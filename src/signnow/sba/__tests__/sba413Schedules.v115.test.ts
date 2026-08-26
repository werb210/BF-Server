// BF_SERVER_SBA_413_SCHEDULES_v115
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SBA_413_FIELDS as F } from "../fieldMaps.js";

const builder = readFileSync(resolve(__dirname, "..", "sbaFormBuilder.ts"), "utf-8");

describe("Section 2 - notes payable", () => {
  it("writes every column of a noteholder row", () => {
    for (const f of [
      "noteholderName", "noteholderOriginalBalance", "noteholderCurrentBalance",
      "noteholderPayment", "noteholderFrequency", "noteholderCollateral",
    ]) {
      expect(builder).toContain(`F413.${f}(i)`);
    }
  });

  it("respects the five-row capacity of the paper form", () => {
    expect(builder).toContain("slice(0, F413.MAX_NOTEHOLDER_ROWS)");
    expect(F.MAX_NOTEHOLDER_ROWS).toBe(5);
  });

  it("rows are 1-indexed, matching the field names", () => {
    expect(builder).toContain("const i = idx + 1;");
    expect(F.noteholderName(1)).toBe("Names and Addresses of NoteholdersRow1");
  });
});

describe("Section 4 - real estate owned", () => {
  it("uses the lettered fields, not numbers", () => {
    expect(builder).toContain('(["A", "B", "C"] as const)');
    expect(F.propertyAddress("A")).toContain("Property A");
  });

  it("writes all four columns", () => {
    for (const f of ["propertyType", "propertyAddress", "propertyMarketValue", "propertyMortgageBalance"]) {
      expect(builder).toContain(`F413.${f}(letter)`);
    }
  });

  it("skips an absent property rather than writing blanks", () => {
    expect(builder).toContain("if (!prop) return;");
  });
});

describe("free-text schedules", () => {
  it.each([
    "otherIncomeDescription",
    "section5OtherProperty",
    "section6UnpaidTaxes",
    "section8LifeInsurance",
  ])("%s is written", (f) => {
    expect(builder).toContain(`F413.${f}`);
  });
});

describe("second signature block", () => {
  it("is filled only when a joint holder is named", () => {
    expect(builder).toContain("if (s(d?.joint_name))");
    expect(builder).toContain("F413.printName2");
    expect(builder).toContain("F413.ssn2");
  });
});

describe("capacity", () => {
  it("overflow is logged, not silently dropped", () => {
    expect(builder).toContain("sba_413_schedule_overflow");
  });
});
