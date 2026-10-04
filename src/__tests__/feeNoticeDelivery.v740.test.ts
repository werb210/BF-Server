// BF_SERVER_FEE_NOTICE_DELIVERY_v740
import { describe, it, expect, vi } from "vitest";
import { deliverFeeNotice, type FeeDeliveryDeps } from "../services/feeAgreement/deliverFeeNotice.js";

function deps(over: Partial<FeeDeliveryDeps> = {}) {
  const rec: Array<[string, string | null]> = [];
  const d: FeeDeliveryDeps = {
    pushApp: vi.fn(async () => true),
    sms: vi.fn(async () => ({ sid: "SM123" })),
    emailReady: () => true,
    email: vi.fn(async () => ({ ok: true })),
    record: vi.fn(async (_a: string, _p: string, channel: string, error: string | null) => { rec.push([channel, error]); }),
    ...over,
  };
  return { d, rec };
}
const base = { applicationId: "a1", phone: "+14035550100", email: "dana@example.com", firstName: "Dana" };

describe("fee agreement notice delivery", () => {
  it("texts even when the app accepted a push, and emails too", async () => {
    const { d, rec } = deps();
    const out = await deliverFeeNotice(base, d);
    expect(out).toMatchObject({ push: true, sms: true, email: true, phoneLast4: "0100", emailTo: "dana@example.com" });
    expect(d.sms).toHaveBeenCalledTimes(1);
    expect(rec.map((r) => r[0])).toEqual(["sms", "email"]);
  });
  it("does not count a TEST_MODE skip as a text", async () => {
    const { d } = deps({ sms: vi.fn(async () => ({ success: true })), pushApp: vi.fn(async () => false) });
    const out = await deliverFeeNotice(base, d);
    expect(out.sms).toBe(false);
    expect(out.email).toBe(true);
    expect(out.errors.join(" ")).toMatch(/TEST_MODE/);
  });
  it("throws with the reasons when nothing went out", async () => {
    const { d } = deps({ pushApp: vi.fn(async () => false), sms: vi.fn(async () => { throw new Error("21610 unsubscribed"); }), emailReady: () => false });
    await expect(deliverFeeNotice(base, d)).rejects.toThrow(/21610 unsubscribed.*SendGrid/);
  });
  it("throws when the file has no mobile and no email", async () => {
    const { d } = deps();
    await expect(deliverFeeNotice({ applicationId: "a1", phone: null, email: null, firstName: null }, d)).rejects.toThrow(/no usable mobile.*no email/);
  });
});
