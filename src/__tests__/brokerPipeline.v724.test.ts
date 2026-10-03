// BF_SERVER_BROKER_PIPELINE_v724
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/routes/portal.ts", "utf8");
describe("broker files in the pipeline", () => {
  it("show from upload even while still a draft waiting for the client", () => {
    expect(src).toContain("(COALESCE(a.pipeline_state, '') NOT IN ('draft','Draft','') OR a.source = 'broker_import')");
  });
  it("cards carry the broker's name and the split status", () => {
    expect(src).toContain("AS broker_name,");
    expect(src).toContain("AS broker_split_status");
    expect(src).toContain("broker_split_status: r.broker_split_status ?? null,");
  });
});
