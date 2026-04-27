import { describe, expect, it } from "vitest";

function isDraftLike(row: any): boolean {
  if (!row) return false;

  const metaDraft = String(row?.metadata?.isDraft ?? "false").toLowerCase() === "true";
  if (metaDraft) return true;

  const name = String(row?.name ?? "").trim().toLowerCase();
  const placeholderName = name === "" || name === "draft" || name === "draft application";
  const pipelineState = String(row?.pipeline_state ?? "").trim().toLowerCase();
  const initialPipeline = pipelineState === "received" || pipelineState === "draft" || pipelineState === "new";

  return placeholderName && initialPipeline;
}

describe("Block 20 — draft list filter", () => {
  it("flags metadata drafts", () => {
    expect(isDraftLike({ metadata: { isDraft: true }, name: "Acme", pipeline_state: "Review" })).toBe(true);
  });

  it("flags placeholder names in initial states", () => {
    expect(isDraftLike({ name: "Draft application", pipeline_state: "Received" })).toBe(true);
    expect(isDraftLike({ name: "", pipeline_state: "Draft" })).toBe(true);
  });

  it("keeps real applications", () => {
    expect(isDraftLike({ name: "North Star Transport", pipeline_state: "Received", metadata: { isDraft: false } })).toBe(false);
    expect(isDraftLike({ name: "Draft application", pipeline_state: "Submitted" })).toBe(false);
  });
});
