// BF_SERVER_SBA_NO_BANK_STATEMENTS_v763
import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { computeOutstandingDocs, dropBankStatements } from "../routes/clientDocumentsNeeded.js";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { docsNeededRules } from "./helpers/docsNeededHarness.js";

const { queryMock, isSba } = vi.hoisted(() => ({ queryMock: vi.fn(), isSba: vi.fn(async () => true) }));
vi.mock("../db.js", () => ({ pool: { query: queryMock }, runQuery: queryMock }));
vi.mock("../signnow/sba/sbaTrigger.js", () => ({ isSbaApplication: isSba }));
vi.mock("../services/documentSharing.js", () => ({
  shareFromOtherApplications: vi.fn(async () => 0),
  sharedDocumentsFor: vi.fn(async () => []),
}));

const APP = "44444444-5555-4666-8777-888888888888";
const PRODUCT_DOCS = ["6 months business banking statements", "Articles of incorporation, operating agreement or DBA", "bank_statements_6_months"];

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
  beforeEach(() => {
    queryMock.mockReset();
    isSba.mockReset();
  });

  it("applies to the client's to-do list; staff Request Items still win", async () => {
    isSba.mockResolvedValue(true);
    queryMock.mockImplementation(answerBySql(docsNeededRules({ productDocs: PRODUCT_DOCS })));
    const sba = await computeOutstandingDocs(APP);
    expect(sba.required.map((d) => d.document_type)).toEqual(["Articles of incorporation, operating agreement or DBA"]);
    expect(isSba).toHaveBeenCalledWith(APP);

    // Staff asked for bank statements from Request Items: that request is not filtered.
    queryMock.mockImplementation(answerBySql(docsNeededRules({ productDocs: PRODUCT_DOCS, requested: ["Bank Statements"] })));
    const requested = await computeOutstandingDocs(APP);
    expect(requested.required.map((d) => d.document_type)).toEqual(["Articles of incorporation, operating agreement or DBA", "Bank Statements"]);
    expect(requested.required.find((d) => d.document_type === "Bank Statements")?.required).toBe(true);
  });

  it("a non-SBA file keeps its bank statements", async () => {
    isSba.mockResolvedValue(false);
    queryMock.mockImplementation(answerBySql(docsNeededRules({ productDocs: PRODUCT_DOCS })));
    expect((await computeOutstandingDocs(APP)).required.map((d) => d.document_type)).toEqual(PRODUCT_DOCS);
  });

  it("the wizard upload step drops them for the SBA category only", async () => {
    const products = [{ id: "p1", required_documents: ["Bank Statements", "business_plan", { category: "bank_statements_6_months", required: true }] }];
    queryMock.mockImplementation(
      answerBySql([
        [/information_schema\.columns/, { rows: [{ column_name: "required_documents" }, { column_name: "category" }] }],
        [/SELECT id, required_documents FROM lender_products/, { rows: products }],
      ]),
    );
    const app = express();
    app.use("/api/portal", (await import("../routes/lenderProductsRequiredDocs.js")).default);
    const sba = await request(app).get("/api/portal/lender-products/required-docs").query({ product_category: "SBA_GOVERNMENT" });
    expect(sba.status).toBe(200);
    expect(sba.body.items.map((i: { document_type: string }) => i.document_type)).toEqual(["business_plan"]);
    expect(callsMatching(queryMock, /FROM lender_products WHERE/).at(-1)![1]).toEqual(["sba"]);

    const term = await request(app).get("/api/portal/lender-products/required-docs").query({ product_category: "TERM_LOAN" });
    expect(term.body.items.map((i: { document_type: string }) => i.document_type)).toEqual(["Bank Statements", "bank_statements_6_months", "business_plan"]);
  });
});
