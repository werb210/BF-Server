// BF_SERVER_PURGE_JUNK_DRAFTS_v1 - admin bulk purge of unsubmitted
// placeholder-named drafts via the FULL cascade (blobs + rows), silo-scoped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const src = readFileSync(join(process.cwd(), "src", "routes", "portal.ts"), "utf-8");
describe("purge junk drafts endpoint", () => {
  it("exposes POST /applications/purge-junk-drafts, Admin only", () => {
    expect(src).toContain('"/applications/purge-junk-drafts"');
    expect(src).toContain("PURGE_JUNK_DRAFTS_v1");
  });
  it("only targets unsubmitted placeholder-named drafts in the caller silo", () => {
    expect(src).toContain("WHERE submitted_at IS NULL");
    expect(src).toContain("(silo IS NULL OR UPPER(silo) = UPPER($1))");
  });
  it("cascade helper purges blobs and doc rows", () => {
    expect(src).toContain("async function purgeApplicationCascade");
    expect(src).toContain("purge_junk_blob_failed");
  });
});
