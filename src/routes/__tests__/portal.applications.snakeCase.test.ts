// BF_SERVER_BLOCK_v161_TEST_SUITE_REFRESH_v1
// Updated to match current portal.ts response shape: keys are
// snake_case and the source field is `r` (not `row`). Original test
// pinned `row.X` substrings which never matched current code.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("portal /applications response shape (snake_case)", () => {
  const portalSrc = fs.readFileSync(path.resolve(__dirname, "../portal.ts"), "utf8");

  it("response uses snake_case fields", () => {
    expect(portalSrc).toContain("pipeline_state: r.stage");
    expect(portalSrc).toMatch(/created_at: r\.(last_activity_at|created_at)/);
    expect(portalSrc).toContain("business_legal_name: r.business_name");
    expect(portalSrc).toContain("requested_amount:");
  });

  it("GET /applications requires auth", () => {
    expect(portalSrc).toMatch(
      /router\.get\(\s*"\/applications",[\s\S]{0,200}?requireAuth,[\s\S]{0,200}?requireAuthorization/,
    );
  });
});
