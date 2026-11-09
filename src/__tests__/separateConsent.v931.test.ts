// BF_SERVER_v931_SEPARATE_CONSENT - texts/calls and email boxes recorded on their own.
import { describe, expect, it, vi } from "vitest";
import { parseExpressCaslConsent, recordExpressCaslConsent } from "../services/smsConsent.js";

const now = new Date("2026-11-09T20:00:00Z");
describe("separate consent boxes", () => {
  it("reads the two boxes", () => {
    expect(parseExpressCaslConsent({ sms_consent: true, email_consent: false, casl_consent: true }, now)).toMatchObject({ sms: true, email: false });
    expect(parseExpressCaslConsent({ sms_consent: false, email_consent: true, casl_consent: true }, now)).toMatchObject({ sms: false, email: true });
    expect(parseExpressCaslConsent({ sms_consent: false, email_consent: false, casl_consent: false }, now)).toBeNull();
    expect(parseExpressCaslConsent({ casl_consent: true }, now)).toMatchObject({ sms: true, email: true });
  });
  it("writes only what was ticked", async () => {
    const q = vi.fn(async () => ({ rowCount: 1 }));
    await recordExpressCaslConsent(q, { contactId: "c1" }, { text: "t", at: now, sms: false, email: true }, "website");
    expect(q).toHaveBeenCalledTimes(1);
    expect(String((q.mock.calls[0] as unknown[])[0])).toContain("email_consent_basis = 'express'");
    q.mockClear();
    await recordExpressCaslConsent(q, { email: "a@b.co", silo: "BF" }, { text: "t", at: now, sms: true, email: false }, "website");
    expect(String((q.mock.calls[0] as unknown[])[0])).toContain("sms_consent    = true");
    expect(q).toHaveBeenCalledTimes(1);
  });
});
