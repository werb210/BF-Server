// BF_SERVER_BLOCK_v2_LIVE_TRANSCRIPTION - unit-tests the pure injection helper so
// it is deterministic (no middleware / signature / DB). Proves the gate and the
// staff-leg-only behaviour, and that the callback points at /transcription/event.
import { describe, it, expect, afterEach } from "vitest";
import { injectLiveTranscription } from "../conferenceWebhooks.js";

const BASE = "https://example.com";
const TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Dial answerOnBridge="true"><Conference>c1</Conference></Dial></Response>';

describe("injectLiveTranscription", () => {
  afterEach(() => { delete process.env.ENABLE_LIVE_TRANSCRIPTION; });

  it("injects <Transcription> on the staff leg when the flag is on", () => {
    process.env.ENABLE_LIVE_TRANSCRIPTION = "true";
    const out = injectLiveTranscription(TWIML, BASE, "test-conf", false);
    expect(out).toContain("<Start><Transcription");
    expect(out).toContain("/transcription/event?conf=test-conf");
    expect(out).toContain('track="both_tracks"');
  });

  it("does nothing when the flag is off", () => {
    const out = injectLiveTranscription(TWIML, BASE, "test-conf", false);
    expect(out).toBe(TWIML);
  });

  it("does nothing on the caller leg even when the flag is on", () => {
    process.env.ENABLE_LIVE_TRANSCRIPTION = "true";
    const out = injectLiveTranscription(TWIML, BASE, "test-conf", true);
    expect(out).toBe(TWIML);
  });
});
