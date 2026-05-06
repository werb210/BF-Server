// BF_SERVER_BLOCK_v161_TEST_SUITE_REFRESH_v1
// Originally guarded the BF_SERVER_v64_UPLOAD_GUARD sentinel. The sentinel
// was overwritten when documents.ts was re-touched in v138. Functional
// invariants (try/catch around persistAndEnqueue, UPLOAD_FAILED error)
// remain valid and are still asserted below.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("documents upload guard (functional)", () => {
  const src = readFileSync(join(__dirname, "..", "routes", "documents.ts"), "utf8");
  it("/public-upload handler wraps persistAndEnqueue in try/catch", () => {
    const idxRoute = src.indexOf('router.post("/public-upload"');
    const idxNext = src.indexOf('router.post("/upload"', idxRoute);
    expect(idxRoute).toBeGreaterThan(-1);
    expect(idxNext).toBeGreaterThan(idxRoute);
    const block = src.slice(idxRoute, idxNext);
    expect(block).toMatch(/try\s*{[\s\S]*persistAndEnqueue\([\s\S]*}\s*catch/);
    expect(block).toContain('"UPLOAD_FAILED"');
  });
  it("/upload handler wraps persistAndEnqueue in try/catch", () => {
    const idxRoute = src.indexOf('router.post("/upload"');
    const idxNext = src.indexOf('router.post("/:id/accept"', idxRoute);
    expect(idxRoute).toBeGreaterThan(-1);
    expect(idxNext).toBeGreaterThan(idxRoute);
    const block = src.slice(idxRoute, idxNext);
    expect(block).toMatch(/try\s*{[\s\S]*persistAndEnqueue\([\s\S]*}\s*catch/);
    expect(block).toContain('"UPLOAD_FAILED"');
  });
});
