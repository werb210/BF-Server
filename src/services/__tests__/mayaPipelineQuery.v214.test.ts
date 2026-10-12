// BF_SERVER_BLOCK_v214_MAYA_STAFF_PIPELINE_QUERY_v1
import { describe, it, expect, vi, beforeEach } from "vitest";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js"; // BF_SERVER_v789_SQL_CONTENT_MOCKS

const queryMock = vi.fn();
vi.mock("../../db.js", () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import { runPipelineQuery, __test } from "../mayaPipelineQuery.js";

describe("BF_SERVER_BLOCK_v214 — pipeline query matcher", () => {
  beforeEach(() => queryMock.mockReset());

  it("matches 'oldest active application'", () => {
    const m = __test.matchQuery("what is the oldest active application?");
    expect(m.matched).toBe(true);
    if (m.matched) expect(m.query.key).toBe("oldest_active_application");
  });

  it("matches 'apps without bank statements'", () => {
    const m = __test.matchQuery("show me apps without bank statements");
    expect(m.matched).toBe(true);
    if (m.matched) expect(m.query.key).toBe("apps_missing_bank_statements");
  });

  it("matches 'approvals this week'", () => {
    const m = __test.matchQuery("how many approvals this week");
    expect(m.matched).toBe(true);
    if (m.matched) expect(m.query.key).toBe("approvals_this_week");
  });

  it("matches 'submissions today'", () => {
    const m = __test.matchQuery("submissions today please");
    expect(m.matched).toBe(true);
    if (m.matched) expect(m.query.key).toBe("submissions_today");
  });

  it("returns not_supported for unmatched questions", () => {
    const m = __test.matchQuery("what's the weather in calgary");
    expect(m.matched).toBe(false);
  });

  it("runPipelineQuery returns rows + summary when matched", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM applications[\s\S]*ORDER BY created_at ASC/, { rows: [{ id: "a1", name: "Acme", created_at: "2025-01-01" }] }],
    ]));
    const r = await runPipelineQuery("oldest active application");
    expect(r.ok).toBe(true);
    expect(r.not_supported).toBeFalsy();
    expect(r.rows?.length).toBe(1);
    expect(r.summary).toContain("Acme");
  });

  it("runPipelineQuery returns the canned-list on no match", async () => {
    const r = await runPipelineQuery("how is morale on the team");
    expect(r.ok).toBe(true);
    expect(r.not_supported).toBe(true);
    expect(r.supported_queries?.length).toBeGreaterThan(0);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
