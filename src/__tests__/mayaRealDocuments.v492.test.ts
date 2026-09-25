// BF_SERVER_BLOCK_v492_MAYA_REAL_DOCUMENTS
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../routes/mayaStaff.ts", import.meta.url)), "utf-8");

describe("v492 Maya reads real documents", () => {
  it("builds rows from computeOutstandingDocs and the documents table", () => {
    expect(src).toContain('await import("./clientDocumentsNeeded.js")');
    expect(src).toContain("SELECT category, status FROM documents WHERE application_id::text = $1");
  });
  it("no per-application read of the empty application_required_documents table remains", () => {
    expect(src).not.toMatch(/FROM application_required_documents WHERE application_id::text/);
    expect(src).not.toMatch(/FROM application_required_documents\s+WHERE application_id::text = \$1 AND status/);
  });
  it("all five document answers use the helper", () => {
    expect(src.match(/mayaDocRows\(/g)?.length).toBe(6); // definition + 5 uses
    expect(src).toContain('mayaDocRows(String(applications[0].id), "client")');
  });
});
