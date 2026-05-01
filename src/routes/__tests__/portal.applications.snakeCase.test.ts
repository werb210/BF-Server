// BF_SERVER_BLOCK_1_32_BACKLOG_CLEANUP
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("BF_SERVER_BLOCK_1_32_BACKLOG_CLEANUP — portal /applications shape", () => {
  const portalSrc = fs.readFileSync(path.resolve(__dirname, "../portal.ts"), "utf8");

  it("response uses snake_case fields", () => {
    expect(portalSrc).toContain("pipeline_state: row.pipeline_state");
    expect(portalSrc).toContain("created_at: row.created_at");
    expect(portalSrc).toContain("submitted_at: row.submitted_at");
    expect(portalSrc).toContain("business_legal_name: row.business_legal_name");
    expect(portalSrc).toContain("requested_amount:");
  });

  it("response no longer uses old camelCase keys for these fields", () => {
    expect(portalSrc).not.toMatch(/pipelineState: row\.pipeline_state/);
    expect(portalSrc).not.toMatch(/createdAt: row\.created_at/);
    expect(portalSrc).not.toMatch(/submittedAt: row\.submitted_at/);
  });

  it("GET /applications now requires auth", () => {
    expect(portalSrc).toMatch(
      /router\.get\(\s*"\/applications",[\s\S]{0,200}?requireAuth,[\s\S]{0,200}?requireAuthorization/,
    );
  });
});
