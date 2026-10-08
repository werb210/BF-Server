// BF_SERVER_CREDIT_DOC_KINDS_v783
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

const rows = [
  { id: "1", name: "Endless Sky FS 2022.pdf", category: "3 years accountant prepared financials", ocr_text: "x" },
  { id: "2", name: "A_RAgingSummaryReport.xlsx", category: "A/R", ocr_text: "x" },
  { id: "3", name: "A_PAgingSummaryReport.xlsx", category: "A/P", ocr_text: "x" },
  { id: "4", name: "Jan 2026.pdf", category: "6 months business banking statements", ocr_text: "x" },
  { id: "5", name: "old.pdf", category: "financial_statements", ocr_text: "x" },
];
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: async () => ({ rows }) } }));
import { documentsOfKinds, kindOf } from "../services/credit/docKinds.js";

describe("credit summary readers find documents filed under their requirement labels", () => {
  it("resolves the labels staff see", () => {
    expect(kindOf("3 years accountant prepared financials")).toBe("financial_statements");
    expect(kindOf("A/R")).toBe("accounts_receivable_aging");
    expect(kindOf("A/P")).toBe("accounts_payable_aging");
    expect(kindOf("6 months business banking statements")).toBe("bank_statements_6_months");
  });
  it("financials, collateral and bank statements each get their documents", async () => {
    expect((await documentsOfKinds("A1", ["financial_statements", "tax_returns"])).map((d) => d.id)).toEqual(["1", "5"]);
    expect((await documentsOfKinds("A1", ["accounts_receivable_aging", "accounts_payable_aging"])).map((d) => d.id)).toEqual(["2", "3"]);
    expect((await documentsOfKinds("A1", ["bank_statements_6_months", "flinks_banking"])).map((d) => d.id)).toEqual(["4"]);
  });
  it("all three readers use it; research reports a count; a numeric legal name is not used as the name", () => {
    expect(readFileSync("src/services/credit/financials.ts", "utf8")).toContain("documentsOfKinds(applicationId, [\"financial_statements\"");
    expect(readFileSync("src/services/credit/collateral.ts", "utf8")).toContain("documentsOfKinds(applicationId, Object.keys(CATEGORY_KIND))");
    expect(readFileSync("src/services/credit/creditSummaryV2.ts", "utf8")).toContain("m.documentsOfKinds(applicationId, [\"bank_statements_6_months\", \"flinks_banking\"])");
    expect(readFileSync("src/routes/creditResearch.ts", "utf8")).toContain("res.json({ ...result, list: loaded.facts, found: result.facts });");
    expect(readFileSync("src/services/credit/creditSummaryV2.ts", "utf8")).toContain("!/^[\\d\\s-]+$/.test(String(n))");
  });
});
