// BF_SERVER_v809_SMS_UPDATES_CONSENT
// Carriers require an unticked "Text me updates about my application" box. Automatic application texts go
// only to numbers that said yes; everyone else is told by the app or by email. Staff can still text by hand.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  SMS_UPDATES_CONSENT_TEXT,
  UPSERT_SMS_UPDATES_CONSENT_SQL,
  getSmsUpdatesConsent,
  phone10,
  recordSmsUpdatesConsent,
  smsUpdatesAllowed,
} from "../smsUpdatesConsent.js";
import { notifyClient, type NotifyDeps } from "../notifications/notifyClient.js";
import { deliverFeeNotice, type FeeDeliveryDeps } from "../feeAgreement/deliverFeeNotice.js";
import { runAction } from "../../modules/automation/automationSteps.js";

function fakeQuery(rows: any[] = []) {
  const calls: Array<[string, unknown[]]> = [];
  const q = async (sql: string, params: unknown[]) => {
    calls.push([sql, params]);
    return /SELECT consent FROM sms_updates_consents/.test(sql) ? { rows } : { rows: [], rowCount: 1 };
  };
  return { q, calls };
}

describe("the client's choice is stored per mobile number", () => {
  it("keeps the last 10 digits", () => {
    expect(phone10("+1 (587) 444-1234")).toBe("5874441234");
    expect(phone10("123")).toBe("");
  });

  it("a yes stores the exact checkbox wording; a no stores none", async () => {
    const { q, calls } = fakeQuery();
    expect(await recordSmsUpdatesConsent("+15874441234", true, "sign_in", q)).toBe(true);
    expect(calls[0]![0]).toBe(UPSERT_SMS_UPDATES_CONSENT_SQL);
    expect(calls[0]![1]).toEqual(["5874441234", true, SMS_UPDATES_CONSENT_TEXT, "sign_in"]);
    await recordSmsUpdatesConsent("5874441234", false, "client_portal", q);
    expect(calls[1]![1]).toEqual(["5874441234", false, null, "client_portal"]);
  });

  it("the wording says frequency varies and the box is not required", () => {
    expect(SMS_UPDATES_CONSENT_TEXT).toContain("Message frequency varies.");
    expect(SMS_UPDATES_CONSENT_TEXT).toContain("Reply STOP to opt out, HELP for help.");
    expect(SMS_UPDATES_CONSENT_TEXT).toContain("Not required to apply.");
    expect(SMS_UPDATES_CONSENT_TEXT).not.toContain("Up to 10");
  });

  it("a failed write never throws", async () => {
    const q = async () => { throw new Error("db down"); };
    expect(await recordSmsUpdatesConsent("5874441234", true, "sign_in", q as any)).toBe(false);
  });

  it("only an explicit yes allows a text; no choice, a no, or a failed lookup do not", async () => {
    expect(await smsUpdatesAllowed("5874441234", fakeQuery([{ consent: true }]).q)).toBe(true);
    expect(await smsUpdatesAllowed("5874441234", fakeQuery([{ consent: false }]).q)).toBe(false);
    expect(await smsUpdatesAllowed("5874441234", fakeQuery([]).q)).toBe(false);
    expect(await getSmsUpdatesConsent("5874441234", fakeQuery([]).q)).toBeNull();
    expect(await smsUpdatesAllowed("5874441234", (async () => { throw new Error("x"); }) as any)).toBe(false);
  });
});

describe("automatic client notices", () => {
  const notice = { phone: "+15874441234", applicationId: "a1", kind: "documents_remaining", sms: "text", title: "Documents needed", body: "Please upload." };
  const deps = (over: Partial<NotifyDeps>): NotifyDeps => ({
    pushReady: async () => false,
    pushUsersForPhone: async () => [],
    push: async () => 0,
    sms: vi.fn(async () => undefined),
    record: async () => undefined,
    ...over,
  });

  it("texts a client who said yes", async () => {
    const d = deps({ smsAllowed: async () => true, email: vi.fn(async () => true) });
    expect(await notifyClient(notice, d)).toEqual({ channel: "sms" });
    expect(d.email).not.toHaveBeenCalled();
  });

  it("emails a client who did not say yes, and never texts them", async () => {
    const d = deps({ smsAllowed: async () => false, email: vi.fn(async () => true) });
    expect(await notifyClient(notice, d)).toEqual({ channel: "email" });
    expect(d.sms).not.toHaveBeenCalled();
  });

  it("no yes and no email: nothing goes out, with the reason recorded", async () => {
    const d = deps({ smsAllowed: async () => false, email: async () => false });
    expect(await notifyClient(notice, d)).toEqual({ channel: "none", error: "no_sms_updates_consent" });
    expect(d.sms).not.toHaveBeenCalled();
  });

  it("the app still comes first", async () => {
    const d = deps({ pushReady: async () => true, pushUsersForPhone: async () => ["client:5874441234"], push: async () => 1, smsAllowed: async () => false });
    expect(await notifyClient(notice, d)).toEqual({ channel: "push" });
  });

});

describe("other automatic texts", () => {
  it("the fee-agreement notice is emailed, not texted, without a yes", async () => {
    const sms = vi.fn(async () => ({ sid: "SM1" }));
    const deps: FeeDeliveryDeps = {
      pushApp: async () => false, sms, emailReady: () => true,
      email: async () => ({ ok: true }), record: async () => undefined, smsAllowed: async () => false,
    };
    const out = await deliverFeeNotice({ applicationId: "a1", phone: "+15874441234", email: "c@x.co", firstName: "Sam" }, deps);
    expect(sms).not.toHaveBeenCalled();
    expect(out.sms).toBe(false);
    expect(out.email).toBe(true);
  });

  it("an automation's transactional text needs the yes", async () => {
    const seen: string[] = [];
    const deps: any = { query: async (sql: string) => { seen.push(sql); return { rows: [] }; }, sendSms: vi.fn() };
    const r = await runAction(deps, { contact_id: "c1", context: {} }, { type: "send_sms", purpose: "transactional", body: "hi" } as any);
    expect(r).toBe("skip: no phone, opted out, or no text consent");
    expect(seen.some((sql) => sql.includes("FROM sms_updates_consents suc"))).toBe(true);
    expect(deps.sendSms).not.toHaveBeenCalled();
  });
});

describe("the migration", () => {
  it("is idempotent and keeps clients who agreed under the earlier sign-in notice", () => {
    const m = readFileSync("migrations/2026_10_15_sms_updates_consent.sql", "utf8");
    expect(m).toContain("CREATE TABLE IF NOT EXISTS sms_updates_consents");
    expect(m).toContain("'prior_sign_in_notice'");
    expect(m).toContain("COALESCE(c.sms_opt_out, false) = false");
    expect(m).toContain("ON CONFLICT (phone10) DO NOTHING");
  });
});
