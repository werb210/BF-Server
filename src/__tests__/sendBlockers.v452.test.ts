import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(__dirname, "../routes/submissionOrchestration.ts"),
  "utf8",
);

describe("v452 lender send blockers", () => {
  it("returns an all-failed dispatch as a blocker from both send routes", () => {
    expect(source).toContain("BF_SERVER_BLOCK_v452_SEND_BLOCKERS");
    expect(source).toContain('reason?.startsWith("dispatch_all_failed:")');
    expect(source.match(/res\.status\(409\)\.json/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("does not bypass the orchestrator with a second direct dispatch", () => {
    expect(source).not.toContain('import { dispatchToSelected');
    expect(source).not.toContain('await dispatchToSelected(');
    expect(source).toContain("sent: orchestrator.stageB.sentTo ?? []");
  });
});
