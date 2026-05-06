// BF_SERVER_BLOCK_v161_TEST_SUITE_REFRESH_v1
// Originally pinned BF_SERVER_v65_PIPELINE_DRAFTS sentinel + a
// `where submitted_at is not null` SQL fragment. Both were superseded
// by v101 (include_drafts param expansion) and v131 (pipeline SQL
// repair using pipeline_state filter). Updated to assert current reality.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("portal /applications drafts handling", () => {
  const src = readFileSync(join(__dirname, "..", "routes", "portal.ts"), "utf8");

  it("handler reads include_drafts query param", () => {
    expect(src).toMatch(/req\.query\.include_drafts/);
  });

  it("default branch filters out draft pipeline_state when include_drafts is falsy", () => {
    expect(src).toMatch(/COALESCE\(a\.pipeline_state, ''\) NOT IN \('draft','Draft',''\)/);
  });

  it("response payload includes pipeline_state on cards", () => {
    expect(src).toMatch(/pipeline_state: r\.stage/);
  });
});
