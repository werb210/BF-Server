// BF_SERVER_VOICEMAIL_PER_STAFF_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const list = readFileSync(path.join(process.cwd(),"src/routes/crm/voicemails.ts"),"utf8");
const hook = readFileSync(path.join(process.cwd(),"src/routes/webhooks.ts"),"utf8");
const mig  = readFileSync(path.join(process.cwd(),"migrations/2026_07_10_voicemail_staff_user.sql"),"utf8");
describe("voicemail per staff (v1)", () => {
  it("list filters by the logged-in user", () => {
    // BF_SERVER_REPAIR_STALE_TESTS_v1 - the filter was deliberately widened to also
    // surface voicemails with no owner yet (staff_user_id IS NULL), so an unassigned
    // voicemail is not invisible to everyone. The per-staff guarantee still holds:
    // a voicemail STAMPED to another user is never returned.
    expect(list).toContain("v.staff_user_id = $2 OR v.staff_user_id IS NULL");
    expect(list).toContain("req.user?.userId");
  });
  it("webhook stamps the call's staff_user_id", () => {
    expect(hook).toContain("findCallLogByTwilioSid");
  });
  it("migration adds column + backfills", () => {
    expect(mig).toContain("ADD COLUMN IF NOT EXISTS staff_user_id");
    expect(mig).toContain("FROM call_logs cl");
  });
});
