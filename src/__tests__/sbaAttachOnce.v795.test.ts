// BF_SERVER_SBA_ATTACH_ONCE_v795
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const s = readFileSync("src/signnow/sba/sbaSigning.ts", "utf8");
const attach = s.slice(s.indexOf("async function attachSignedSbaDocumentsUnlocked") /* BF_SERVER_SBA_TEST_ANCHOR_v798 - v796 moved the filing body behind a lock wrapper */);
describe("signed SBA forms are filed once per signing", () => {
  it("each signed copy carries its SignNow document id", () => {
    expect(s).toContain("docId, // BF_SERVER_SBA_ATTACH_ONCE_v795");
  });
  it("a copy from the same SignNow document is not filed again on the next webhook", () => {
    expect(attach.indexOf("metadata->>'signnow_doc_id' = $2")).toBeGreaterThan(0);
    expect(attach.indexOf("metadata->>'signnow_doc_id' = $2")).toBeLessThan(attach.indexOf("UPDATE documents SET hash = $2"));
  });
  it("new and replaced versions both record the SignNow document id", () => {
    expect((attach.match(/signnow_doc_id: pdf\.docId \?\? null/g) ?? []).length).toBe(2);
  });
});
