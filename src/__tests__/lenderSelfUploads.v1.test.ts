import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const src = readFileSync(join(process.cwd(), "src", "routes", "lenderSelf.ts"), "utf-8");

describe("lender self uploads", () => {
  it("stores in lender_documents scoped to the lender and ingests to Maya", () => {
    expect(src).toContain("BF_SERVER_LENDER_SELF_UPLOADS_v1");
    expect(src).toContain("INSERT INTO lender_documents");
    expect(src).toContain("lender_id::text = $1");
    // BF_SERVER_LENDER_TESTS_v58 - v57 replaced the POST to the agent's
    // /api/knowledge/ingest (which did not exist, and whose failure was
    // swallowed) with a direct embedAndStore call. Same guarantee, real path.
    expect(src).toContain("embedAndStore");
    expect(src).toContain('"lender_document"');
    expect(src).not.toContain("/api/knowledge/ingest");
  });
});
