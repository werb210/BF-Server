// BF_SERVER_AUTO_CALL_SUMMARY_v245
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

// The routes call the module with only their own argument (production deps); the unit tests
// below pass injected deps. Route calls are recorded and answered here, unit calls go to the real code.
const wire = vi.hoisted(() => ({ summarize: [] as unknown[][], lookups: [] as unknown[][] }));
vi.mock("../autoCallSummary.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    summarizeCompletedTranscript: (...a: unknown[]) => (a.length > 1 ? real.summarizeCompletedTranscript(...a) : (wire.summarize.push(a), Promise.resolve("saved"))),
    summaryForCallSid: (...a: unknown[]) => (a.length > 1 ? real.summaryForCallSid(...a) : (wire.lookups.push(a), Promise.resolve({ status: "ready", summary: "S", contactId: "c1", suggestedTasks: [] }))),
  };
});
vi.mock("../../../middleware/twilioWebhookValidation.js", async (orig) => ({ ...(await orig<any>()), twilioWebhookValidation: (_req: any, _res: any, next: any) => next() }));
vi.mock("../../../voice/conferenceService.js", async (orig) => ({
  ...(await orig<any>()),
  getConferenceByFriendly: async () => ({ id: "11111111-2222-4333-8444-555555555555" }),
  notifyConferenceState: async () => undefined,
}));
vi.mock("../../mmsMedia.js", async (orig) => ({ ...(await orig<any>()), persistTwilioMediaToBlob: async () => null }));
vi.mock("../../../voice/twilioClient.js", async (orig) => {
  const transcripts: any = (sid: string) => ({ fetch: async () => ({ sid, status: "completed" }), sentences: { list: async () => [{ transcript: "Hi Walter", media_channel: 1 }] } });
  transcripts.create = async () => ({ sid: "GT1" });
  return { ...(await orig<any>()), getTwilio: () => ({ intelligence: { v2: { transcripts } } }) };
});
vi.mock("../../../db.js", async (orig) => {
  const real: any = await orig();
  const q = async () => ({ rows: [], rowCount: 0 });
  return { ...real, pool: { query: q }, dbQuery: q };
});

import { summarizeCompletedTranscript, summaryForCallSid } from "../autoCallSummary.js";
import recordingWebhooks from "../../../routes/recordingWebhooks.js";
import callsRoutes from "../../../routes/calls.js";

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
  afterEach(() => { vi.useRealTimers(); delete process.env.VOICE_INTELLIGENCE_SERVICE_SID; });

  it("runs when the transcript completes", async () => {
    wire.summarize.length = 0;
    process.env.VOICE_INTELLIGENCE_SERVICE_SID = "GA_test";
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use("/api/voice", recordingWebhooks);
    // The transcript poll waits 6 s between checks.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const r = await request(app).post("/api/voice/recording/status?conf=room-1").type("form")
      .send({ RecordingSid: "RE1", RecordingStatus: "completed", RecordingUrl: "https://api.twilio.com/rec/RE1", RecordingDuration: "42" });
    expect(r.status).toBe(200);
    expect(wire.summarize).toEqual([]);
    await vi.advanceTimersByTimeAsync(6_500);
    await vi.waitFor(() => expect(wire.summarize).toEqual([[CONF]]));
  });

  it("exposes the dialer endpoint", async () => {
    wire.lookups.length = 0;
    const app = express();
    app.use("/api/calls", callsRoutes);
    const staff = "Bearer " + jwt.sign({ sub: "77777777-7777-4777-8777-777777777777", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
    const sid = "CA" + "a".repeat(32);
    const r = await request(app).get("/api/calls/summary?callSid=" + sid).set("Authorization", staff);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain('"summary":"S"');
    expect(wire.lookups).toEqual([[sid]]);
    expect((await request(app).get("/api/calls/summary?callSid=nope").set("Authorization", staff)).status).not.toBe(200);
    expect((await request(app).get("/api/calls/summary?callSid=" + sid)).status).toBe(401);
  });
});
