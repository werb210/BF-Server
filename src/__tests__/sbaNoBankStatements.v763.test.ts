// BF_SERVER_SBA_NO_BANK_STATEMENTS_v763
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dropBankStatements, computeOutstandingDocs } from "../routes/clientDocumentsNeeded.js";

const state = vi.hoisted(() => ({ sba: true, requested: false }));
vi.mock("../signnow/sba/sbaTrigger.js", () => ({ isSbaApplication: async () => state.sba }));
vi.mock("../db.js", () => ({ pool: { query: async (sql: string) => {
  if (sql.includes("SELECT metadata FROM applications")) return { rows: [{ metadata: { productRequirements: { aggregated: [
    { document_type: "bank_statements_6_months", required: true },
    { document_type: "Articles", required: true },
  ] } } }] };
  if (sql.includes("FROM application_document_requests")) return { rows: state.requested ? [{ document_type: "bank_statements_6_months" }] : [] };
  return { rows: [] };
} } }));
beforeEach(() => { state.sba = true; state.requested = false; });

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
  it("omits automatic SBA banking requirements but preserves staff requests and non-SBA requirements", async () => {
    expect((await computeOutstandingDocs("app")).stillNeeded.map(d => d.document_type)).toEqual(["Articles"]);
    state.requested = true;
    expect((await computeOutstandingDocs("app")).stillNeeded.map(d => d.document_type)).toEqual(["Articles", "bank_statements_6_months"]);
    state.sba = false;
    state.requested = false;
    expect((await computeOutstandingDocs("app")).stillNeeded.map(d => d.document_type)).toEqual(["bank_statements_6_months", "Articles"]);
  });
  it("applies to the client's to-do list and the wizard upload step; staff Request Items still win", () => {
    const needed = readFileSync("src/routes/clientDocumentsNeeded.ts", "utf8");
    expect(needed).toContain("if (await isSbaApplication(applicationId)) dropBankStatements(required);");
    expect(needed.indexOf("dropBankStatements(required)")).toBeLessThan(needed.indexOf("BF_SERVER_REQUESTED_DOCS_v351 - documents staff requested"));
    expect(readFileSync("src/routes/lenderProductsRequiredDocs.ts", "utf8")).toContain('if (product_category === "sba") {');
  });
});
