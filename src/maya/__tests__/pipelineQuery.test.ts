// AGENT_BLOCK_v2_AUDIENCE_AND_STAFF_PIPELINE_TOOL_v1
import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
vi.mock("../../integrations/bfServerClient.js", () => ({
  callBFServer: (...args: unknown[]) => callMock(...args),
}));

import { pipelineQuery, PIPELINE_QUERY_TOOL_DESCRIPTOR } from "../tools/pipelineQuery.js";

describe("AGENT_BLOCK_v2 — pipelineQuery tool", () => {
  beforeEach(() => callMock.mockReset());

  it("forwards the question verbatim to BF-Server", async () => {
    callMock.mockResolvedValueOnce({ ok: true, rows: [], summary: "no matches" });
    await pipelineQuery({ question: "oldest active application" });
    expect(callMock).toHaveBeenCalledWith(
      "/api/maya/staff/pipeline-query",
      { method: "POST", body: { question: "oldest active application" } },
    );
  });

  it("returns ok=false on empty question", async () => {
    const r = await pipelineQuery({ question: "   " });
    expect(r.ok).toBe(false);
    expect(callMock).not.toHaveBeenCalled();
  });

  it("returns ok=false on transport error", async () => {
    callMock.mockRejectedValueOnce(new Error("network"));
    const r = await pipelineQuery({ question: "anything" });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("pipeline_query_failed");
  });

  it("descriptor advertises name and required arg", () => {
    expect(PIPELINE_QUERY_TOOL_DESCRIPTOR.function.name).toBe("pipeline.query");
    expect(PIPELINE_QUERY_TOOL_DESCRIPTOR.function.parameters.required).toEqual(["question"]);
  });
});
