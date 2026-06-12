// BF_SERVER_BLOCK_v862_PIPELINE_SHOW_CLOSING_COSTS — guards that the default
// pipeline board filter surfaces closing-cost companion applications as their
// own cards instead of hiding every companion under the parent.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("v862 pipeline shows closing-cost companions", () => {
  const src = readFileSync(resolve(__dirname, "../portal.ts"), "utf8");
  it("carries the v862 sentinel", () => {
    expect(src).toContain("BF_SERVER_BLOCK_v862_PIPELINE_SHOW_CLOSING_COSTS");
  });
  it("default board filter admits closing_costs_companion rows", () => {
    expect(src).toContain("(a.parent_application_id IS NULL OR a.source = 'closing_costs_companion')");
  });
  it("does not retain the unconditional companion-hiding filter", () => {
    expect(src).not.toContain("where.push(`a.parent_application_id IS NULL`);");
  });
});
