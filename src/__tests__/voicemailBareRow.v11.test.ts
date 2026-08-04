// BF_SERVER_VOICEMAIL_BARE_ROW_v11
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const webhook = readFileSync(path.join(process.cwd(), "src/routes/webhooks.ts"), "utf8");
const migration = readFileSync(
  path.join(process.cwd(), "migrations/2026_08_03_voicemail_recording_sid_unique.sql"),
  "utf8",
);

describe("voicemail bare row", () => {
  it("writes a row before enrichment can fail", () => {
    const handler = webhook.slice(webhook.indexOf('router.post("/twilio/voicemail"'));
    const insertAt = handler.indexOf("INSERT INTO voicemails");
    const enrichAt = handler.indexOf("enrichAndDistributeVoicemail({");
    expect(insertAt).toBeGreaterThan(-1);
    expect(enrichAt).toBeGreaterThan(insertAt);
  });

  it("cannot duplicate, because the row now has a unique key", () => {
    expect(webhook).toContain("ON CONFLICT (recording_sid) DO NOTHING");
    // The arbiter this relies on. Without it the two writes race, which is why
    // v9 removed the bare insert in the first place.
    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS voicemails_recording_sid_uq");
  });

  it("still answers the caller before the slow work starts", () => {
    const handler = webhook.slice(webhook.indexOf('router.post("/twilio/voicemail"'));
    expect(handler.indexOf("res.send(vr.toString())")).toBeLessThan(
      handler.indexOf("void enrichAndDistributeVoicemail({"),
    );
  });

  it("keeps the reception ownership hint ahead of the call-log lookup", () => {
    expect(webhook).toContain("const staffHint = typeof req.query?.staff");
    expect(webhook).toContain("const vmStaffUserId = staffHint ??");
  });

  it("stamps the same owner on both writes", () => {
    const handler = webhook.slice(webhook.indexOf('router.post("/twilio/voicemail"'));
    expect(handler).toContain("staffUserId: vmStaffUserId");
  });

  it("surfaces either write failing", () => {
    expect(webhook).toContain("voicemail_insert_failed");
    expect(webhook).toContain("voicemail_enrich_failed");
  });
});
