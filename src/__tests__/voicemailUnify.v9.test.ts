// BF_SERVER_VOICEMAIL_UNIFY_v9
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
const enrich = read("../modules/voice/voicemailEnrich.service.ts");
const webhooks = read("../routes/webhooks.ts");
const twilioRoutes = read("../routes/twilio.ts");
const migration = read("../../migrations/2026_08_03_voicemail_recording_sid_unique.sql");

describe("voicemail unification", () => {
  it("deduplicates before adding a recording SID unique key", () => {
    expect(migration).toContain("ON voicemails (recording_sid)");
    expect(migration.indexOf("DELETE FROM voicemails")).toBeLessThan(migration.indexOf("CREATE UNIQUE INDEX"));
  });
  it("upserts enriched voicemail fields", () => {
    expect(enrich).toContain("ON CONFLICT (recording_sid) DO UPDATE SET");
    expect(enrich).toContain("transcript       = COALESCE(EXCLUDED.transcript, voicemails.transcript)");
    expect(enrich).toContain("staff_user_id    = COALESCE(EXCLUDED.staff_user_id, voicemails.staff_user_id)");
    expect(enrich).toContain("voicemail_row_upsert_failed");
  });
  it("carries reception caller and owner data into enrichment", () => {
    expect(enrich).toContain("fromNumber?: string | null;");
    expect(enrich).toContain("staffUserId?: string | null;");
    expect(enrich).toContain("if (staffUserId) {");
    expect(webhooks).toContain('req.query?.staff === "string"');
    expect(webhooks).toContain('const fromNum = typeof From === "string" ? From : null;');
    expect(webhooks).toContain("fromNumber: fromNum,");
  });
  it("persists a bare row and responds before invoking the enrichment path", () => {
    const handler = webhooks.slice(webhooks.indexOf('router.post("/twilio/voicemail"'));
    expect(handler).toContain("INSERT INTO voicemails");
    expect(handler).toContain("ON CONFLICT (recording_sid) DO NOTHING");
    expect(handler.indexOf("res.send(vr.toString())")).toBeLessThan(handler.indexOf("enrichAndDistributeVoicemail({"));
    expect(twilioRoutes).toContain("void enrichAndDistributeVoicemail({");
    expect(twilioRoutes).not.toContain("await enrichAndDistributeVoicemail({");
  });
});
