// BF_SERVER_BLOCK_v461_SIGNING_NOTICE
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";

const dbQuery = vi.fn();
const sendSms = vi.fn();
vi.mock("../db.js", () => ({ dbQuery: (...a: any[]) => dbQuery(...a) }));
vi.mock("../modules/notifications/sms.service.js", () => ({ sendSms: (...a: any[]) => sendSms(...a) }));

import { remindOwner1ToSign, describeOwner1Notice } from "../signnow/ownerSigningNotice.js";

const APP = "467689d3-2008-42a6-87d3-720919c6e5b9";
function contact(row: Record<string, unknown>) {
  dbQuery.mockImplementation(async (sql: string) => (sql.includes("SELECT") ? { rows: [row] } : { rows: [] }));
}
const voss = { first: "Brandon", last: "Voss", phone: "+19173043342", sms_at: "2026-09-24T17:46:18Z" };

beforeEach(() => { dbQuery.mockReset(); sendSms.mockReset(); });

describe("v461 signing text to Owner 1", () => {
  it("a second Send re-texts Owner 1 to sign in the CMP and says who", async () => {
    contact(voss);
    const n = await remindOwner1ToSign(APP, new Date("2026-09-24T18:10:00Z"));
    expect(n).toMatchObject({ name: "Brandon Voss", phone: "+19173043342", smsSent: true, resent: true, throttled: false });
    expect(sendSms.mock.calls[0][0].to).toBe("+19173043342");
    expect(sendSms.mock.calls[0][0].message).toContain("client.boreal.financial");
    expect(sendSms.mock.calls[0][0].message).toContain("Reply STOP to opt out");
    expect(dbQuery.mock.calls.some(([sql]) => String(sql).includes("owner1_signing_sms_at") && String(sql).startsWith("UPDATE"))).toBe(true);
  });

  it("does not spam: within two minutes of the last text nothing is sent", async () => {
    contact(voss);
    const n = await remindOwner1ToSign(APP, new Date("2026-09-24T17:47:00Z"));
    expect(n).toMatchObject({ throttled: true, resent: false });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("reports a missing phone instead of pretending", async () => {
    contact({ ...voss, phone: "123", sms_at: null });
    const n = await remindOwner1ToSign(APP, new Date("2026-09-24T18:10:00Z"));
    expect(n).toMatchObject({ phone: null, smsSent: false, resent: false });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("a failed text is reported, not counted as sent", async () => {
    contact({ ...voss, sms_at: null });
    sendSms.mockRejectedValue(new Error("twilio 21610"));
    const n = await remindOwner1ToSign(APP, new Date("2026-09-24T18:10:00Z"));
    expect(n).toMatchObject({ smsSent: false, resent: false });
  });

  it("describe reports who was texted without sending", async () => {
    contact(voss);
    const n = await describeOwner1Notice(APP);
    expect(n).toMatchObject({ name: "Brandon Voss", phone: "+19173043342", smsSent: true, lastSentAt: "2026-09-24T17:46:18Z" });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("Owner 1 is never emailed", () => {
    const src = fs.readFileSync("src/signnow/ownerSigningNotice.ts", "utf8");
    expect(src).not.toContain("sendViaGraph");
  });

  it("the orchestrator resends on a second Send and reports the notice on the first", () => {
    const src = fs.readFileSync("src/services/submission/orchestrator.ts", "utf8");
    expect(src).toContain("snap.applicationSigned ? undefined : await signingNoticeFor(ctx.applicationId, true)");
    expect(src).toContain("const notice = await signingNoticeFor(ctx.applicationId, false);");
  });
});
