import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(__dirname, "../services/submission/orchestrator.ts"),
  "utf8",
);

describe("v452 dispatch delivery result", () => {
  it("does not report success or advance the pipeline when every lender fails", () => {
    expect(source).toContain("BF_SERVER_BLOCK_v452_SEND_BLOCKERS");
    expect(source).toContain("if (sentTo.length === 0)");
    expect(source).toContain("dispatch_all_failed:");
    expect(source.indexOf("if (sentTo.length === 0)")).toBeLessThan(
      source.indexOf("SET pipeline_state = 'Off to Lender'"),
    );
  });

  it("loads the persisted adapter failure reason", () => {
    expect(source).toContain("SELECT failure_reason");
    expect(source).toContain("status = 'failed'");
    expect(source).toContain("no_lender_accepted_package");
  });
});
