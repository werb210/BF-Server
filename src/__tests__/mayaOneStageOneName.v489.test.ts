// BF_SERVER_BLOCK_v489_MAYA_ONE_STAGE_ONE_NAME
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../routes/mayaStaff.ts", import.meta.url)), "utf-8");

describe("v489 Maya one stage, one name", () => {
  it("application-summary returns the top-level fields the client tools read", () => {
    for (const f of ["pipeline_state: stage,", "documents: dr.rows.map(", "bi_completion_url: app.bi_completion_url ?? null,", "requested_amount: app.requested_amount,"]) {
      expect(src).toContain(f);
    }
    expect(src).toContain("bi_public_id, bi_completion_url -- BF_SERVER_BLOCK_v489");
  });
  it("a missing application is audited", () => {
    expect(src).toContain('summary: "application not found", errorCode: "not_found"');
  });
  it("find_mine gives one business name, the application's", () => {
    expect(src).toContain("businessName: a.name ?? null, // BF_SERVER_BLOCK_v489");
    expect(src).toContain("companyName: (applications[0]?.businessName ?? null) || (first.company_name ?? null),");
  });
});
