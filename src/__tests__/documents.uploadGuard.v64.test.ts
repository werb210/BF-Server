// BF_SERVER_v64_UPLOAD_GUARD
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("BF_SERVER_v64_UPLOAD_GUARD", () => {
  const src = readFileSync(join(__dirname, "..", "routes", "documents.ts"),"utf8");
  it("anchor present", () => { expect(src.includes("BF_SERVER_v64_UPLOAD_GUARD")).toBe(true); });
  it("/public-upload handler wraps persistAndEnqueue in try/catch", () => {
    const idxRoute = src.indexOf('router.post("/public-upload"');
    const idxNext  = src.indexOf('router.post("/upload"', idxRoute);
    expect(idxRoute).toBeGreaterThan(-1); expect(idxNext).toBeGreaterThan(idxRoute);
    const block = src.slice(idxRoute, idxNext);
    expect(block).toMatch(/try\s*{[\s\S]*persistAndEnqueue\([\s\S]*}\s*catch/);
    expect(block).toContain('"UPLOAD_FAILED"');
  });
  it("/upload handler wraps persistAndEnqueue in try/catch", () => {
    const idxRoute = src.indexOf('router.post("/upload"');
    const idxNext  = src.indexOf('router.post("/:id/accept"', idxRoute);
    expect(idxRoute).toBeGreaterThan(-1); expect(idxNext).toBeGreaterThan(idxRoute);
    const block = src.slice(idxRoute, idxNext);
    expect(block).toMatch(/try\s*{[\s\S]*persistAndEnqueue\([\s\S]*}\s*catch/);
    expect(block).toContain('"UPLOAD_FAILED"');
  });
});
