// BF_SERVER_v65_PIPELINE_DRAFTS
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("BF_SERVER_v65_PIPELINE_DRAFTS", () => {
  const src = readFileSync(join(__dirname, "..", "routes", "portal.ts"), "utf8");
  it("anchor present", () => { expect(src.includes("BF_SERVER_v65_PIPELINE_DRAFTS")).toBe(true); });
  it("/applications handler reads include_drafts query param", () => {
    expect(src).toMatch(/req\?\.query\?\.include_drafts/);
  });
  it("default branch filters submitted_at IS NOT NULL", () => {
    expect(src).toMatch(/where submitted_at is not null/);
  });
  it("returns submittedAt in the items mapping", () => {
    expect(src).toMatch(/submittedAt: row\.submitted_at \?\? null/);
  });
});
