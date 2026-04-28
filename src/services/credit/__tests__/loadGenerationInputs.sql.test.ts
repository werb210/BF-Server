// BF_CREDIT_SCHEMA_FIX_v52 — regression test for Bug 1.
// BF_CREDIT_SCHEMA_FIX_v52_TESTFIX_v2 — drop .js from vi.mock spec and reset
// modules in beforeEach so the hoisted runQuery mock binds.
import { describe, it, expect, vi, beforeEach } from "vitest";

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
    runQueryMock
      .mockResolvedValueOnce({ rows: [{
        id: "app-1", name: "X", requested_amount: 1000, industry: null,
        product_category: null, product_type: null, pipeline_state: null,
        metadata: {},
      }] })
      .mockResolvedValueOnce({ rows: [
        { category: "Bank Statements", cnt: "3" },
        { category: "general",         cnt: "2" },
      ] })
      .mockResolvedValueOnce({ rows: [{ analyzed: "0" }] });

    const { loadGenerationInputs } = await import("../generateCreditSummary.js");
    const inputs = await loadGenerationInputs("app-1");

    expect(runQueryMock).toHaveBeenCalledTimes(3);
    const docCallSql = String(runQueryMock.mock.calls[1][0]);
    expect(docCallSql).toContain("signed_category");
    expect(docCallSql).toContain("document_type");
    expect(docCallSql).toContain("COALESCE(signed_category, document_type, 'unknown')");
    expect(docCallSql).not.toMatch(/GROUP BY\s+category\b/i);
    expect(docCallSql).not.toMatch(/FROM documents[\s\S]*WHERE[\s\S]*\bcategory\b\s*=/i);

    expect(inputs.documentCounts["Bank Statements"]).toBe(3);
    expect(inputs.documentCounts["general"]).toBe(2);
  });
});
