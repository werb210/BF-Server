// BF_SERVER_MG_SHEET_REAL_COLUMNS_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildSheetRow, toTenDigits, yearsSince, toNumber,
  mapEntityType, mapIndustry, mapProvince, type SheetRowData,
} from "../merchantGrowthSheet.js";
const r = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

const sample: SheetRowData = {
  applicationId: "app-1",
  firstName: "Todd", lastName: "Werboweski", company: "Todd's Trucking Co.",
  email: "todd@example.com", mobile: "5878881837", phone: "5555555555",
  dob: "1971-04-14", language: "English",
  requestedAmount: "50000", annualRevenue: "1100000", monthlySales: "91667",
  street: "123", city: "Edmonton", province: "AB", country: "Canada", postalCode: "T5R 0P0",
  yearsInBusiness: "3", entityType: "Corporation", industry: "Transportation",
  useOfFunds: "Working capital",
};

describe("merchant growth sheet row", () => {
  it("matches the lender template's 20 columns, in their exact order", () => {
    const { headers, values } = buildSheetRow(sample);
    // G-Connector maps by COLUMN ORDER. If this ever drifts, every submission lands in
    // Salesforce with the fields in the wrong columns - hence an exact-order assertion.
    expect(headers).toEqual([
      "First Name",
      "Last Name*",
      "Company*",
      "Email",
      "Mobile!\n(10 digits)",
      "Phone!\n(10 digits)",
      "Date of Birth\n(YYYY-MM-DD)",
      "Language!",
      "Requested Amount!\n(Currency)",
      "Annual Revenue!\n(Currency)",
      "Estimated Monthly Sales!\n(Currency)",
      "Street",
      "City",
      "Province!",
      "Country!",
      "Postal Code!",
      "Years in Business!\n(Integer)",
      "Entity Type!",
      "Industry!",
      "Use of Funds",
    ]);
    expect(headers.length).toBe(20);
    expect(values.length).toBe(headers.length);
    expect(values[2]).toBe("Todd's Trucking Co.");
    expect(values[17]).toBe("Corporation");
  });

  it("strips E.164 phone numbers down to the 10 digits they require", () => {
    expect(toTenDigits("+15878881837")).toBe("5878881837");
    expect(toTenDigits("(555) 555-5555")).toBe("5555555555");
    expect(toTenDigits("")).toBe("");
  });

  it("derives years in business from the Step 3 start date", () => {
    const now = new Date("2026-07-13T00:00:00Z");
    expect(yearsSince("2022-05-03", now)).toBe("4");
    expect(yearsSince("2022-09-03", now)).toBe("3");
    expect(yearsSince("", now)).toBe("");
  });

  it("strips currency formatting for their Currency columns", () => {
    expect(toNumber("$1,100,000")).toBe("1100000");
    expect(toNumber(50000)).toBe("50000");
    expect(toNumber("")).toBe("");
  });

  it("maps our Business Structure onto their Entity Type vocabulary", () => {
    expect(mapEntityType("Corporation")).toBe("Corporation");
    expect(mapEntityType("sole proprietorship")).toBe("Sole Proprietorship");
    // never guess: an unknown structure is left blank, not invented
    expect(mapEntityType("Co-operative")).toBe("");
  });

  it("maps our industry values onto theirs, falling back to Other", () => {
    expect(mapIndustry("Restaurant / Food Service")).toBe("Food & Beverage");
    expect(mapIndustry("Transportation")).toBe("Transportation");
    expect(mapIndustry("Manufacturing")).toBe("Other");
    expect(mapIndustry("")).toBe("");
  });

  it("only emits valid 2-letter provinces", () => {
    expect(mapProvince("AB")).toBe("AB");
    expect(mapProvince("Alberta")).toBe("");
  });

  it("adapter appends a column-ordered row to the configured tab", () => {
    const a = r("src/modules/submissions/adapters/GoogleSheetSubmissionAdapter.ts");
    expect(a).toContain("async appendRow");
    expect(a).toContain("${this.sheetName}!A1");
  });
});
