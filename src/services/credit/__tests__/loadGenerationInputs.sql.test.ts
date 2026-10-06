import { describe, it, expect, vi, beforeEach } from "vitest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js"; // BF_SERVER_SQL_CONTENT_MOCKS_v762

const runQueryMock = vi.fn();

vi.mock("../../../lib/db", () => ({
  runQuery: runQueryMock,
}));

describe("BF_CREDIT_SCHEMA_FIX_v52 loadGenerationInputs SQL shape", () => {
  beforeEach(() => {
    vi.resetModules();
    runQueryMock.mockReset();
  });

  it("queries signed_category and document_type, never bare 'category'", async () => {
    runQueryMock.mockImplementation(answerBySql([
      [/AS analyzed/, { rows: [{ analyzed: "0" }] }],
      [/COALESCE\(signed_category, document_type, 'unknown'\)/, { rows: [
        { category: "Bank Statements", cnt: "3" },
        { category: "general",         cnt: "2" },
      ] }],
      [/FROM applications/, { rows: [{
        id: "app-1", name: "X", requested_amount: 1000, industry: null,
        product_category: null, product_type: null, pipeline_state: null,
        metadata: {},
      }] }],
    ]));

    const { loadGenerationInputs } = await import("../generateCreditSummary.js");
    const inputs = await loadGenerationInputs("app-1");

    expect(runQueryMock).toHaveBeenCalledTimes(3);
    const docCallSql = String(callsMatching(runQueryMock, "COALESCE(signed_category, document_type, 'unknown')")[0]![0]);
    expect(docCallSql).toContain("signed_category");
    expect(docCallSql).toContain("document_type");
    expect(docCallSql).toContain("COALESCE(signed_category, document_type, 'unknown')");
    expect(docCallSql).not.toMatch(/GROUP BY\s+category\b/i);
    expect(docCallSql).not.toMatch(/FROM documents[\s\S]*WHERE[\s\S]*\bcategory\b\s*=/i);

    expect(inputs.documentCounts["Bank Statements"]).toBe(3);
    expect(inputs.documentCounts["general"]).toBe(2);
  });
});
