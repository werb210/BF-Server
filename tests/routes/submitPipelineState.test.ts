// BF_SERVER_v70_BLOCK_1_2
import { describe, it, expect } from "vitest";
import fs from "node:fs";

describe("submit handler pipeline_state CASE", () => {
  const src = fs.readFileSync("src/routes/client/v1Applications.ts", "utf8");

  it("includes the v70_BLOCK_1_2 sentinel comment", () => {
    expect(src).toContain("BF_SERVER_v70_BLOCK_1_2");
  });

  it("writes pipeline_state via a CASE that checks for documents", () => {
    expect(src).toMatch(/pipeline_state\s*=\s*CASE[\s\S]+EXISTS \(\s*SELECT 1 FROM documents/);
    expect(src).toContain("'Received'");
    expect(src).toContain("'Documents Required'");
  });

  it("preserves an already-advanced pipeline_state (only updates from null/draft)", () => {
    expect(src).toMatch(/pipeline_state IS NULL OR pipeline_state IN \('draft','Draft',''\)/);
  });
});
