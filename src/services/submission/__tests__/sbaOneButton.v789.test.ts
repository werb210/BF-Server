// BF_SERVER_SBA_ONE_BUTTON_v789
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const h = vi.hoisted(() => ({
  envelopes: 0,
  start: vi.fn(),
  notifyAdmins: vi.fn(async () => {}),
  remind: vi.fn(async () => ({ name: "Todd", phone: "+15875550100", smsSent: true, resent: true, throttled: false, lastSentAt: null })),
  describe: vi.fn(async () => ({ name: "Todd", phone: "+15875550100", smsSent: true, resent: false, throttled: false, lastSentAt: "2026-10-08T22:00:00Z" })),
  claimed: false,
  signed: null as string | null,
}));

vi.mock("../../../signnow/sba/sbaTrigger.js", () => ({
  isSbaApplication: vi.fn(async () => true),
  sbaEnvelopeCount: vi.fn(async () => h.envelopes),
  startSbaSigningForStaff: h.start,
}));
vi.mock("../../../routes/clientDocumentsNeeded.js", () => ({ computeOutstandingDocs: vi.fn(async () => ({ stillNeeded: [], rejected: [], required: [] })) }));
vi.mock("../../../signnow/ownerSigningNotice.js", () => ({ remindOwner1ToSign: h.remind, describeOwner1Notice: h.describe }));
vi.mock("../../notifications/notifyAdminsForCreditSummary.js", () => ({ notifyAdminsForCreditSummary: h.notifyAdmins }));

import { maybeStartCreditSummaryAndSign } from "../orchestrator.js";

const pool: any = {
  query: vi.fn(async (sql: string) => {
    if (/FROM application_tasks/.test(sql)) return { rows: [{ open_count: "0" }] };
    if (/MAX\(finalized_at\)/.test(sql)) return { rows: [{ finalized_at: "2026-10-08T00:00:00Z" }] };
    if (/SELECT credit_summary_completed_at/.test(sql)) return { rows: [{ credit_summary_completed_at: null, signnow_app_signed_at: h.signed, requested_amount: 1000000 }] };
    if (/AS accord/.test(sql)) return { rows: [{ accord: false }] };
    if (/AS complete/.test(sql)) return { rows: [{ complete: false }] };
    if (/SET submission_chain_started_at = NOW\(\)/.test(sql)) { if (h.claimed) return { rows: [] }; h.claimed = true; return { rows: [{ id: "a1" }] }; }
    if (/SET submission_chain_started_at = NULL/.test(sql)) { h.claimed = false; return { rows: [] }; }
    return { rows: [] };
  }),
};
const ctx = { pool, applicationId: "a1" };

describe("Send on the Lenders tab starts SBA signing", () => {
  beforeEach(() => {
    h.envelopes = 0; h.claimed = false; h.signed = null;
    h.start.mockReset(); h.notifyAdmins.mockClear(); h.remind.mockClear(); h.describe.mockClear();
  });
  it("starts the one SBA signing and reports who was texted", async () => {
    h.start.mockResolvedValue({ started: true, owners: [{ ownerIndex: 1, name: "Todd", email: "t@x.com", started: true, delivery: "client portal" }] });
    const r = await maybeStartCreditSummaryAndSign(ctx);
    expect(h.start).toHaveBeenCalledWith("a1");
    expect(r.fired).toBe(true);
    expect(r.notice?.phone).toBe("+15875550100");
  });
  it("never sends the staff credit-summary alert for an SBA file", async () => {
    h.start.mockResolvedValue({ started: true, owners: [] });
    await maybeStartCreditSummaryAndSign(ctx);
    expect(h.notifyAdmins).not.toHaveBeenCalled();
  });
  it("Send again while unsigned re-texts owner 1 instead of making new envelopes", async () => {
    h.envelopes = 2;
    const r = await maybeStartCreditSummaryAndSign(ctx);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.remind).toHaveBeenCalled();
    expect(r.reason).toBe("already_started");
  });
  it("says the SBA forms are unfinished and releases the claim so a later Send can retry", async () => {
    h.start.mockResolvedValue({ started: false, reason: "sba_forms_incomplete", missing: ["sba_form_413"] });
    const r = await maybeStartCreditSummaryAndSign(ctx);
    expect(r).toEqual({ fired: false, reason: "sba_forms_incomplete" });
    expect(h.claimed).toBe(false);
  });
  it("does nothing once the file is signed", async () => {
    h.signed = "2026-10-08T00:00:00Z";
    const r = await maybeStartCreditSummaryAndSign(ctx);
    expect(r.reason).toBe("already_signed");
    expect(h.start).not.toHaveBeenCalled();
  });
});

describe("the other entry points use the same start", () => {
  const routes = readFileSync("src/modules/applications/applications.routes.ts", "utf8");
  const forms = readFileSync("src/routes/applicationFormResponses.ts", "utf8");
  it("Send for signing on the Application tab starts SBA signing on an SBA file", () => {
    const resend = routes.slice(routes.indexOf("router.post('/:id/resend-signing'"));
    expect(resend.indexOf("startSbaSigningForStaff(id)")).toBeGreaterThan(0);
    expect(resend.indexOf("startSbaSigningForStaff(id)")).toBeLessThan(resend.indexOf("getOrCreateEmbeddedSigningSession(id)"));
  });
  it("readiness reports SBA forms unfinished / signing already out", () => {
    expect(routes).toContain("return 'started';");
    expect(routes).toContain("'sba_forms_incomplete'");
  });
  it("the signing badge sees SBA envelopes", () => expect(routes).toContain("md.sba_signnow[0]?.groupId"));
  it("the old SBA-only resend no longer drops the application from the signing", () => {
    const resend = forms.slice(forms.indexOf('"/applications/:id/sba-signing/resend"'));
    expect(resend.slice(0, 900)).toContain("startSbaSigningForStaff(appId)");
    expect(resend.slice(0, 900)).not.toContain("restartSbaSigning(appId)");
  });
});
