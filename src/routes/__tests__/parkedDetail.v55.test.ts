// BF_SERVER_PARKED_DETAIL_v55
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const repo = readFileSync("src/modules/applications/applications.repo.ts", "utf8");
const portal = readFileSync("src/routes/portal.ts", "utf8");

describe("the detail route carries the park details", () => {
  it("selects parked_previous_stage so Reactivate knows where to send the file", () => {
    // The board SELECT has carried this since v49; the single-application
    // route did not, so a tab had no way to offer Reactivate.
    const select = repo.slice(repo.indexOf("`select id, name, pipeline_state"), repo.indexOf("limit 1`"));
    expect(select).toContain("parked_previous_stage");
    expect(select).toContain("parked_reason");
  });

  it("returns them on the application object", () => {
    expect(portal).toContain("parkedPreviousStage: record.parked_previous_stage ?? null,");
    expect(portal).toContain("parkedReason: record.parked_reason ?? null,");
  });

  it("types them as optional so nothing else breaks", () => {
    expect(repo).toContain("parked_previous_stage?: string | null;");
  });

  it("still returns the current stage", () => {
    expect(portal).toContain("pipelineState: record.pipeline_state,");
  });
});
