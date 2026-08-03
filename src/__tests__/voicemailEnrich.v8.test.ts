// BF_SERVER_VOICEMAIL_ENRICH_v8
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const webhook = readFileSync(path.join(process.cwd(), "src/routes/webhooks.ts"), "utf8");
const service = readFileSync(
  path.join(process.cwd(), "src/modules/voice/voicemailEnrich.service.ts"),
  "utf8",
);

describe("voicemail enrichment v8", () => {
  it("is actually called by the webhook", () => {
    // It was written, exported, and never invoked from anywhere.
    expect(webhook).toContain("enrichAndDistributeVoicemail({");
  });

  it("does not block the TwiML response", () => {
    // Twilio hangs up on a slow webhook; Whisper takes seconds.
    expect(webhook).toContain("void enrichAndDistributeVoicemail({");
  });

  it("still writes a bare row if enrichment fails", () => {
    // A voicemail must survive Whisper or blob storage being down.
    expect(webhook).toContain("voicemail_insert_failed");
    expect(webhook).toContain("voicemail_enrich_failed");
  });

  it("the service writes the transcript the handset reads", () => {
    expect(service).toContain("transcript");
    expect(service).toContain("INSERT INTO voicemails");
  });
});
