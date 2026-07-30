// BF_SERVER_WAIVER_REMOVE_BODY_v1
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const src = readFileSync(join(process.cwd(), "src", "routes", "portal.ts"), "utf-8");
const handler = src.slice(
  src.indexOf('router.post("/applications/:id/document-waivers/remove"'),
  src.indexOf('router.delete("/applications/:id/document-waivers/:documentType"'),
);

describe("un-waiving a document type that contains a slash", () => {
  it("takes the document type from the body, not the path", () => {
    expect(handler).toContain("req.body?.document_type ?? req.body?.documentType");
    expect(handler).not.toContain("req.params.documentType");
  });
  it("deletes the waiver row", () => {
    expect(handler).toContain("DELETE FROM application_document_waivers");
    expect(handler).toContain("document_type = $2");
  });
  it("stays admin-only, like the route it replaces", () => {
    expect(handler).toContain("requireAuth, requireAdmin");
  });
  it("leaves the original DELETE route in place for existing callers", () => {
    expect(src).toContain('router.delete("/applications/:id/document-waivers/:documentType"');
  });
  it("a slashed type is untouched by the body path", () => {
    // %2F in a path segment is rejected by Azure before Express runs; in a JSON
    // body "A/P" is just a string.
    expect(encodeURIComponent("A/P")).toBe("A%2FP");
    expect(JSON.parse(JSON.stringify({ document_type: "A/P" })).document_type).toBe("A/P");
  });
});
