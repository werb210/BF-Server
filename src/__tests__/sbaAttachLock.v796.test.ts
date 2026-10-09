// BF_SERVER_SBA_ATTACH_LOCK_v796
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const s = readFileSync("src/signnow/sba/sbaSigning.ts", "utf8");
const m = readFileSync("migrations/2026_10_09_v796_sba_doc_dedupe.sql", "utf8");
describe("signed SBA forms are filed once, even when SignNow webhooks arrive together", () => {
  it("one filing run per application at a time", () => {
    const fn = s.slice(s.indexOf("async function attachSignedSbaDocumentsLocked"));
    expect(fn).toContain("pg_advisory_lock(hashtext($1))");
    expect(fn.indexOf("pg_advisory_lock")).toBeLessThan(fn.indexOf("attachSignedSbaDocumentsUnlocked(applicationId)"));
    expect(fn).toContain("pg_advisory_unlock(hashtext($1))");
  });
  it("runs in one process queue before taking a connection, so waiters cannot exhaust the pool", () => {
    const fn = s.slice(s.indexOf("export async function attachSignedSbaDocuments"));
    expect(fn).toContain("sbaAttachQueue.get(applicationId)");
    expect(fn).toContain("attachSignedSbaDocumentsLocked(applicationId)");
  });
  it("the extra copies already filed are removed, newest kept, and a second copy is impossible", () => {
    expect(m).toContain("ORDER BY updated_at DESC NULLS LAST");
    expect(m).toContain("dup.rn > 1");
    expect(m).toContain("CREATE UNIQUE INDEX IF NOT EXISTS documents_sba_forms_one_per_file");
    expect(m).toContain("WHERE uploaded_by = 'system' AND document_type = 'sba_forms'");
  });
});
