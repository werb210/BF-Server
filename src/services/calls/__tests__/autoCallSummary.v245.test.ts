// BF_SERVER_AUTO_CALL_SUMMARY_v245
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { summarizeCompletedTranscript, summaryForCallSid } from "../autoCallSummary.js";

const CONF = "11111111-2222-4333-8444-555555555555";

function deps(row: Record<string, unknown> | null, answer = "- Promised March statement\nFollow-ups: Friday") {
  const query = vi.fn(async (sql: string) => (sql.includes("FROM conferences cf") ? { rows: row ? [row] : [] } : { rows: [] }));
  const ask = vi.fn(async () => answer);
  return { query, ask };
}

const done = { transcript_id: "t1", full_text: "Hi Walter, send the March statement Friday.", voice_intelligence_summary: null, contact_id: "c1", silo: "BF" };

describe("automatic call summary", () => {
  it("summarizes a completed transcript, stores it, and notes the contact timeline", async () => {
    const d = deps(done);
    expect(await summarizeCompletedTranscript(CONF, d)).toBe("saved");
    expect(d.ask).toHaveBeenCalledWith(done.full_text);
    const sqls = d.query.mock.calls.map(([s]) => String(s));
    expect(sqls.some((s) => s.startsWith("UPDATE call_transcripts SET voice_intelligence_summary"))).toBe(true);
    expect(sqls.some((s) => s.startsWith("INSERT INTO crm_notes"))).toBe(true);
  });
  it("does not summarize twice", async () => {
    const d = deps({ ...done, voice_intelligence_summary: "already" });
    expect(await summarizeCompletedTranscript(CONF, d)).toBe("exists");
    expect(d.ask).not.toHaveBeenCalled();
  });
  it("skips empty transcripts and calls without a contact still get the stored summary", async () => {
    expect(await summarizeCompletedTranscript(CONF, deps({ ...done, full_text: "  " }))).toBe("skipped");
    const d = deps({ ...done, contact_id: null });
    expect(await summarizeCompletedTranscript(CONF, d)).toBe("saved");
    expect(d.query.mock.calls.some(([s]) => String(s).startsWith("INSERT INTO crm_notes"))).toBe(false);
  });
  it("never throws when the AI call fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps(done);
    d.ask.mockRejectedValueOnce(new Error("rate limited"));
    expect(await summarizeCompletedTranscript(CONF, d)).toBe("skipped");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("summary lookup by CallSid", () => {
  const q = (rows: any[]) => vi.fn(async () => ({ rows }));
  it("reports ready, pending, or none", async () => {
    expect(await summaryForCallSid("CA1", q([{ status: "completed", voice_intelligence_summary: "S", contact_id: "c1" }]))).toEqual({ status: "ready", summary: "S", contactId: "c1", suggestedTasks: [] }); // v253 adds suggestedTasks
    expect((await summaryForCallSid("CA1", q([{ status: "in-progress", voice_intelligence_summary: null, contact_id: "c1" }]))).status).toBe("pending");
    expect((await summaryForCallSid("CA1", q([]))).status).toBe("none");
    expect((await summaryForCallSid("CA1", q([{ status: "failed", voice_intelligence_summary: null, contact_id: null }]))).status).toBe("none");
  });
  it("resolves the call through its conference participant row", async () => {
    const query = q([]);
    await summaryForCallSid("CA1", query);
    expect(String((query.mock.calls[0] as any)[0])).toContain("conference_participants p");
  });
});

describe("wiring", () => {
  it("runs when the transcript completes and exposes the dialer endpoint", () => {
    expect(fs.readFileSync("src/routes/recordingWebhooks.ts", "utf8")).toContain("summarizeCompletedTranscript(conferenceId)");
    expect(fs.readFileSync("src/routes/calls.ts", "utf8")).toContain('\"/summary\"');
  });
});
