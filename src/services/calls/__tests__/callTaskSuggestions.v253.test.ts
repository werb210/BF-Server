// BF_SERVER_CALL_TASK_SUGGESTIONS_v253
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { parseSuggestedTasks, summarizeCompletedTranscript, summaryForCallSid } from "../autoCallSummary.js";

const done = { transcript_id: "t1", full_text: "Walter will send March statements Friday; call him Monday.", voice_intelligence_summary: null, contact_id: "c1", silo: "BF" };
const deps = (suggest?: () => Promise<string>) => {
  const query = vi.fn(async (sql: string) => (sql.includes("FROM conferences cf") ? { rows: [done] } : { rows: [] }));
  return { query, ask: vi.fn(async () => "- summary"), suggest };
};

describe("parsing suggestions", () => {
  it("accepts clean JSON and code-fenced JSON, capped at three", () => {
    const four = JSON.stringify([1, 2, 3, 4].map((i) => ({ title: `T${i}`, type: "call", dueInDays: i })));
    expect(parseSuggestedTasks(four)).toHaveLength(3);
    expect(parseSuggestedTasks('```json\n[{"title":"Chase March statement","type":"EMAIL","dueInDays":3}]\n```'))
      .toEqual([{ title: "Chase March statement", type: "EMAIL", dueInDays: 3 }]);
  });
  it("drops malformed output rather than guessing", () => {
    expect(parseSuggestedTasks("Sure! Here are some tasks")).toEqual([]);
    expect(parseSuggestedTasks('{"title":"not an array"}')).toEqual([]);
    expect(parseSuggestedTasks('[{"title":""},{"title":"Call back","type":"FAX","dueInDays":99}]'))
      .toEqual([{ title: "Call back", type: "TODO", dueInDays: 30 }]);
  });
});

describe("storing suggestions", () => {
  it("stores parsed suggestions after the summary", async () => {
    const d = deps(async () => '[{"title":"Call Walter","type":"CALL","dueInDays":3}]');
    expect(await summarizeCompletedTranscript("11111111-2222-4333-8444-555555555555", d)).toBe("saved");
    const call = d.query.mock.calls.find(([sql]) => String(sql).includes("suggested_tasks"));
    expect(call?.[1]).toEqual(["t1", JSON.stringify([{ title: "Call Walter", type: "CALL", dueInDays: 3 }])]);
  });
  it("a suggestion failure never loses the summary", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps(async () => { throw new Error("rate limited"); });
    expect(await summarizeCompletedTranscript("11111111-2222-4333-8444-555555555555", d)).toBe("saved");
    expect(d.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE call_transcripts SET voice_intelligence_summary"))).toBe(true);
    err.mockRestore();
  });
  it("returns suggestions with a ready summary for the dialer", async () => {
    const query = vi.fn(async () => ({ rows: [{ status: "completed", voice_intelligence_summary: "S", contact_id: "c1", suggested_tasks: [{ title: "Call Walter", type: "CALL", dueInDays: 3 }] }] }));
    expect((await summaryForCallSid("CA1", query as any)).suggestedTasks).toEqual([{ title: "Call Walter", type: "CALL", dueInDays: 3 }]);
  });
  it("adds the column idempotently", () => {
    expect(fs.readFileSync("migrations/2026_09_16_v253_call_transcript_suggested_tasks.sql", "utf8"))
      .toContain("ADD COLUMN IF NOT EXISTS suggested_tasks jsonb");
  });
});
