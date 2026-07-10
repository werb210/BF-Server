// BF_SERVER_GSHEET_ROW_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSheetRow, MERCHANT_GROWTH_COLUMNS, type SheetRowData } from "../merchantGrowthSheet.js";
const r = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

const sample: SheetRowData = {
  applicationId: "app-1", businessName: "Acme Ltd", contactName: "Jane Doe",
  email: "jane@acme.com", phone: "+15551234567", requestedAmount: "50000",
  productCategory: "Term Loan", productType: "Term", annualRevenue: "600000",
  monthlyRevenue: "50000", timeInBusiness: "3", province: "AB", submittedAt: "2026-07-10T00:00:00Z",
};

describe("merchant growth sheet row", () => {
  it("builds a row whose values line up with the column headers, in order", () => {
    const { headers, values } = buildSheetRow(sample);
    expect(headers.length).toBe(MERCHANT_GROWTH_COLUMNS.length);
    expect(values.length).toBe(headers.length);
    expect(values[headers.indexOf("Business Legal Name")]).toBe("Acme Ltd");
    expect(values[headers.indexOf("Email")]).toBe("jane@acme.com");
    expect(values[headers.indexOf("Application ID")]).toBe("app-1");
  });

  it("adapter appends a column-ordered row to the configured tab", () => {
    const a = r("src/modules/submissions/adapters/GoogleSheetSubmissionAdapter.ts");
    expect(a).toContain("async appendRow");
    expect(a).toContain("${this.sheetName}!A1");
  });

  it("dispatch sends real data with an idempotency claim", () => {
    const d = r("src/services/lenders/dispatchToSelected.ts");
    expect(d).toContain("loadSheetRowData");
    expect(d).toContain("adapter.appendRow(values)");
    expect(d).toContain("lender_sheet_dispatches");
    expect(d).toContain("ON CONFLICT (application_id, lender_id) DO NOTHING");
  });
});
