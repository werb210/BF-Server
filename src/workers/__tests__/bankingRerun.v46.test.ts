// BF_SERVER_BANKING_RERUN_v46
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const worker = readFileSync("src/workers/bankingAutoWorker.ts", "utf8");

describe("banking auto worker pickup", () => {
  it("treats needs_review as terminal so a flagged run does not loop", () => {
    expect(worker).toMatch(
      /status IN \('in_progress', 'analysis_complete', 'needs_review'\)/,
    );
  });

  it("still leaves pending rows for the worker to pick up, which is how retry works", () => {
    const excluded = worker.match(/status IN \(([^)]*)\)/)?.[1] ?? "";
    expect(excluded).not.toContain("pending");
  });
});
