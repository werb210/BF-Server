// BF_SERVER_SBA_NO_BANK_STATEMENTS_v763
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dropBankStatements } from "../routes/clientDocumentsNeeded.js";

describe("SBA files never ask for bank statements", () => {
  it("removes bank statements whatever the lender product called them, and nothing else", () => {
    const docs = [
      { document_type: "6 months business banking statements", label: "6 months business banking statements" },
      { document_type: "bank_statements_6_months", label: "Bank Statements" },
      { document_type: "Bank Statements", label: "Bank Statements" },
      { document_type: "Articles of incorporation, operating agreement or DBA", label: "Articles" },
      { document_type: "Personal tax returns - last 3 years, each 20%+ owner", label: "Personal tax returns" },
      { document_type: "Business plan with financial projections", label: "Business plan" },
    ];
    expect(dropBankStatements(docs).map((d) => d.label)).toEqual(["Articles", "Personal tax returns", "Business plan"]);
  });
  it("applies to the client's to-do list and the wizard upload step; staff Request Items still win", () => {
    const needed = readFileSync("src/routes/clientDocumentsNeeded.ts", "utf8");
    expect(needed).toContain("if (await isSbaApplication(applicationId)) dropBankStatements(required);");
    expect(needed.indexOf("dropBankStatements(required)")).toBeLessThan(needed.indexOf("BF_SERVER_REQUESTED_DOCS_v351 - documents staff requested"));
    expect(readFileSync("src/routes/lenderProductsRequiredDocs.ts", "utf8")).toContain('if (product_category === "sba") {');
  });
});
