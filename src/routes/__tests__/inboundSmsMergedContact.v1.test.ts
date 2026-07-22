// BF_SERVER_INBOUND_SMS_MERGED_CONTACT_v1
// Source-level guards: both inbound SMS paths need a live pg pool to exercise end to
// end, so assert the properties that regressed in production.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const webhooks = read("src/routes/webhooks.ts");
const inbound = read("src/routes/smsInboundWebhook.ts");
const migration = read("migrations/2026_07_22_repoint_merged_contact_activity.sql");

describe("inbound sms never resolves to a merged-away contact", () => {
  it("webhooks.ts excludes archived contacts", () => {
    expect(webhooks).toContain("WHERE coalesce(status, '') <> 'archived'");
  });

  it("webhooks.ts follows merged_into_id to the live survivor", () => {
    expect(webhooks).toContain("ON surv.id = m.merged_into_id");
    expect(webhooks).toContain("AND surv.merged_into_id IS NULL");
  });

  it("webhooks.ts no longer breaks ties toward the oldest row", () => {
    expect(webhooks).not.toContain("ORDER BY primary_match DESC, created_at ASC NULLS LAST, id ASC");
    expect(webhooks).toContain("primary_match DESC, updated_at DESC NULLS LAST");
  });

  it("smsInboundWebhook.ts excludes archived contacts and follows the merge pointer", () => {
    expect(inbound).toContain("ON surv.id = m.merged_into_id");
    expect(inbound).toContain("WHERE coalesce(status, '') <> 'archived'");
    expect(inbound).not.toContain("ORDER BY created_at ASC\n           LIMIT 1");
  });

  it("smsInboundWebhook.ts also matches on secondary_phone", () => {
    // A merge copies the loser's number onto the survivor's secondary_phone, so a
    // primary-phone-only match could miss the survivor entirely.
    expect(inbound).toContain("secondary_phone IS NOT NULL");
  });

  it("the repair migration walks merge chains and is idempotent", () => {
    expect(migration).toContain("WITH RECURSIVE chain(loser_id, survivor_id)");
    expect(migration).toContain("UPDATE communications_messages m");
    expect(migration).toContain("UPDATE call_logs cl");
    expect(migration).toContain("AND coalesce(s.status, '') <> 'archived'");
  });
});
