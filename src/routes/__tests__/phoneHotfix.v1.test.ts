// BF_SERVER_PHONE_HOTFIX_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const r = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("phone hotfix", () => {
  it("voicemail list shows directed AND general (null-owner) voicemails", () => {
    const s = r("src/routes/crm/voicemails.ts");
    expect(s).toContain("v.staff_user_id = $2 OR v.staff_user_id IS NULL");
  });
  it("reception forwards the real caller id, not the business line", () => {
    const s = r("src/routes/reception.ts");
    expect(s).toContain('String((req.body?.From ?? "")).trim() || config.twilio.callerId');
  });
  it("reception stamps the voicemail with the resolved target staff", () => {
    const s = r("src/routes/reception.ts");
    expect(s).toContain("userId: r.user_id ?? null");
    expect(s).toContain("voicemail?staff=");
    expect(s).toContain("offerMessageOrVoicemail(v, reasonKey, reasonText, t.userId)");
  });
  it("voicemail webhook prefers the ?staff hint over the call_log lookup", () => {
    const s = r("src/routes/webhooks.ts");
    expect(s).toContain("const staffHint = typeof req.query?.staff");
    expect(s).toContain("const vmStaffUserId = staffHint ??");
  });
});
