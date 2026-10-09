// BF_SERVER_LENDER_RESEND_v797
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ signed: true, block: null as null | { reason: string; detail?: string }, priorSent: 1, locked: false, dispatch: vi.fn(async (_c: any, l: any[]) => l.map((x) => x.lender_id)) }));
vi.mock("../orchestrator.js", () => ({ readReadinessSnapshot: vi.fn(async () => ({ applicationSigned: h.signed })) }));
vi.mock("../../../signnow/sba/sbaPackageReadiness.js", () => ({ sbaPackageBlocker: vi.fn(async () => h.block) }));
vi.mock("../../lenders/dispatchToSelected.js", () => ({ dispatchToSelected: h.dispatch }));
import { resendPackageToLender } from "../resendToLender.js";

const L = "11111111-1111-1111-1111-111111111111";
const pool: any = { query: vi.fn(async (sql: string) => {
  if (/FROM application_packages/.test(sql)) return { rows: [{ n: String(h.priorSent) }] };
  if (/FROM lenders l/.test(sql)) return { rows: [{ lender_id: L, name: "Todd's lending company", submission_method: "email", submission_email: "t@x.com", api_endpoint: null, api_key_encrypted: null, google_sheet_id: null, google_sheet_tab: null }] };
  if (/SET submission_packages_started_at = NOW\(\)/.test(sql)) { if (h.locked) return { rows: [] }; h.locked = true; return { rows: [{ id: "a1" }] }; }
  if (/SET submission_packages_started_at = NULL/.test(sql)) { h.locked = false; return { rows: [] }; }
  return { rows: [] };
}) };
const ctx = { pool, applicationId: "a1" };

describe("Resend to a lender", () => {
  beforeEach(() => { h.signed = true; h.block = null; h.priorSent = 1; h.locked = false; h.dispatch.mockClear(); });
  it("sends the current package again to a lender that already has it, and releases the lock", async () => {
    expect(await resendPackageToLender(ctx, L)).toEqual({ ok: true, sentTo: [L] });
    expect(h.dispatch.mock.calls[0]![1][0].lender_id).toBe(L);
    expect(h.locked).toBe(false);
  });
  it("refuses until the application is signed", async () => {
    h.signed = false;
    expect(await resendPackageToLender(ctx, L)).toEqual({ ok: false, reason: "application_not_signed" });
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it("applies the same SBA holds as a normal send", async () => {
    h.block = { reason: "sba_forms_not_signed" };
    expect((await resendPackageToLender(ctx, L)).ok).toBe(false);
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it("is only for lenders that already received the package", async () => {
    h.priorSent = 0;
    expect(await resendPackageToLender(ctx, L)).toEqual({ ok: false, reason: "not_sent_before" });
  });
  it("does not overlap another send of the same file", async () => {
    h.locked = true;
    expect(await resendPackageToLender(ctx, L)).toEqual({ ok: false, reason: "dispatch_in_progress" });
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});
