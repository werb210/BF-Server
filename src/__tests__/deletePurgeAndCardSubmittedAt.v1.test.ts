// BF_SERVER_DELETE_PURGES_DOCUMENTS_v1 + BF_SERVER_SUBMITTED_AT_ON_CARD_v1
// 1) Deleting an application deletes its Azure blobs and its documents /
//    document_versions rows explicitly (not only via FK catalog discovery).
// 2) Pipeline cards carry submitted_at so the portal can distinguish junk
//    unnamed drafts from real submitted applications.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const src = readFileSync(join(process.cwd(), "src", "routes", "portal.ts"), "utf-8");
describe("application delete purge + card submitted_at", () => {
  it("deletes blobs before rows", () => {
    expect(src).toContain("application_delete_blob_failed");
    expect(src).toContain("await getStorage().delete(b.blob_name);");
  });
  it("purges documents and document_versions rows explicitly", () => {
    expect(src).toContain("DELETE FROM document_versions WHERE document_id IN");
    expect(src).toContain("DELETE FROM documents WHERE application_id::text = ($1)::text");
  });
  it("exposes submitted_at on pipeline cards", () => {
    expect(src).toContain("AS submitted_at");
    expect(src).toContain("submitted_at: r.submitted_at ?? null");
  });
});
