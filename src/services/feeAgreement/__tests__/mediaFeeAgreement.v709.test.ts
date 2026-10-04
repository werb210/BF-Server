// BF_SERVER_MEDIA_FEE_AGREEMENT_v709
import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyClient = vi.fn(async () => ({ channel: "sms" as const }));
vi.mock("../../notifications/notifyClient.js", () => ({ notifyClient }));
// BF_SERVER_FEE_NOTICE_DELIVERY_v740 - the trigger now goes through deliverFeeNotice
vi.mock("../deliverFeeNotice.js", () => ({ deliverFeeNotice: (input: unknown) => (notifyClient as any)(input) }));
vi.mock("../../../db.js", () => ({ dbQuery: vi.fn(async () => ({ rows: [] })), pool: { connect: vi.fn() } }));
vi.mock("../../../signnow/signnowClient.js", () => ({
  isApiKeyConfigured: () => false,
  uploadDocumentWithFieldExtract: vi.fn(), createDocumentGroup: vi.fn(), sendGroupEmailInvite: vi.fn(),
  createEmbeddedGroupInvite: vi.fn(), createEmbeddedGroupLink: vi.fn(), getDocumentGroupStatus: vi.fn(), downloadDocument: vi.fn(),
}));

import { agreementDataFrom, backfillFeeAgreementsForLender, ensureMediaFeeAgreement, isMediaCategory, needsFeeAgreement, pickFeeSigner } from "../mediaFeeAgreement.js";
import { agreementParagraphs, buildMediaFeeAgreementPdf, pdfSafe, scheduleAFeeText, scheduleARows } from "../../../signnow/mediaFeeAgreementPdfBuilder.js";

type Row = Record<string, unknown>;
function fakeDb(opts: { category: string; lenders: Row[]; existing?: boolean; sentApps?: string[] }) {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    if (/FROM applications WHERE id/.test(sql)) return { rows: [{ id: "app-1", name: "Northern Films Ltd", requested_amount: "250000", product_category: opts.category, metadata: { applicant: { firstName: "Dana", lastName: "Reyes", phone: "5875550100", email: "dana@example.com", title: "President" } } }] };
    if (/FROM lenders WHERE/.test(sql)) return { rows: opts.lenders };
    if (/INSERT INTO media_fee_agreements/.test(sql)) return { rows: opts.existing ? [] : [{ id: "ag-1" }] };
    if (/FROM application_packages/.test(sql)) return { rows: (opts.sentApps ?? []).map((application_id) => ({ application_id })) };
    return { rows: [] };
  });
  return { query, calls };
}

beforeEach(() => notifyClient.mockClear());

describe("media fee agreement - rules", () => {
  it("recognises every spelling of the media category", () => {
    for (const category of ["MEDIA", "media", "Media Funding", "MEDIA_FINANCE", "media-financing", "MEDIA_FILM_FINANCE"]) expect(isMediaCategory(category)).toBe(true);
    for (const category of ["LOC", "TERM", "", null]) expect(isMediaCategory(category)).toBe(false);
  });
  it("needs the agreement only for media sent to a lender without a broker agreement", () => {
    expect(needsFeeAgreement("MEDIA", [{ has_broker_agreement: false }])).toBe(true);
    expect(needsFeeAgreement("MEDIA", [{ has_broker_agreement: true }])).toBe(false);
    expect(needsFeeAgreement("MEDIA", [{ has_broker_agreement: true }, { has_broker_agreement: null }])).toBe(true);
    expect(needsFeeAgreement("TERM", [{ has_broker_agreement: false }])).toBe(false);
  });
  it("picks the first director, else the applicant", () => {
    expect(pickFeeSigner({ applicant: { firstName: "A", lastName: "One", director: "Yes" } })).toMatchObject({ name: "A One", isApplicant: true, reason: "director" });
    expect(pickFeeSigner({ applicant: { firstName: "A", director: "No", partner: { firstName: "B", lastName: "Two", email: "b@x.com", director: "Yes" } } })).toMatchObject({ name: "B Two", isApplicant: false });
    expect(pickFeeSigner({ applicant: { firstName: "Solo", lastName: "Owner" } })).toMatchObject({ name: "Solo Owner", isApplicant: true, reason: "applicant_fallback" });
  });
});

describe("media fee agreement - wording", () => {
  const data = agreementDataFrom(
    { name: "Northern Films Ltd", requested_amount: "250000", metadata: { business: { legalName: "Northern Films Ltd", city: "Calgary", state: "AB", country: "CA" } } },
    { name: "Dana Reyes", email: null, phone: null, title: "President", isApplicant: true, reason: "applicant_fallback" },
    new Date("2026-10-03T18:00:00Z"),
  );
  it("uses the approved agreement and fee text", () => {
    const all = agreementParagraphs(data).map((p) => (p.bold ?? "") + " " + p.text).join("\n");
    expect(all).toContain("2630108 Alberta Ltd., trading as Boreal Financial (\"BF\")");
    expect(all).toContain("residing/operating in Canada or the United States");
    expect(all).toContain("laws of the Province of Alberta");
    expect(all).not.toMatch(/\bCBF\b|Canadian Business Financing/);
    expect(scheduleAFeeText()).toContain("Two Percent (2.0%)");
    expect(scheduleAFeeText()).not.toMatch(/Engagement|Break Fee|per month/i);
    expect(Object.fromEntries(scheduleARows(data))).toMatchObject({ "COMPANY NAME": "Northern Films Ltd", "CLIENT NAME": "Dana Reyes", "APPROXIMATE FINANCING AMOUNT": "$250,000", "DATE OF SIGNING": "October 3, 2026" });
  });
  it("builds a PDF with unsupported characters safely removed", async () => {
    const bytes = await buildMediaFeeAgreementPdf({ ...data, clientName: "Zoë “Q” 中" });
    expect(Buffer.from(bytes).subarray(0, 4).toString()).toBe("%PDF");
    expect(pdfSafe("“A” — 中")).toBe('"A" - ');
  });
});

describe("media fee agreement - trigger", () => {
  it("does nothing for a non-media file or when every lender pays Boreal", async () => {
    const term = fakeDb({ category: "TERM", lenders: [{ id: "l1", has_broker_agreement: false }] });
    expect(await ensureMediaFeeAgreement("app-1", ["l1"], { query: term.query })).toMatchObject({ created: false, reason: "not_media" });
    const paid = fakeDb({ category: "MEDIA", lenders: [{ id: "l1", has_broker_agreement: true }] });
    expect(await ensureMediaFeeAgreement("app-1", ["l1"], { query: paid.query })).toMatchObject({ created: false, reason: "lender_pays" });
  });
  it("creates once and texts the applicant", async () => {
    const db = fakeDb({ category: "MEDIA", lenders: [{ id: "l1", name: "Bondit", has_broker_agreement: false }] });
    expect(await ensureMediaFeeAgreement("app-1", ["l1"], { query: db.query })).toMatchObject({ created: true });
    expect(notifyClient).toHaveBeenCalledTimes(1);
    expect(notifyClient.mock.calls[0][0]).toMatchObject({ phone: "+15875550100" });
    const existing = fakeDb({ category: "MEDIA", lenders: [{ id: "l1", has_broker_agreement: false }], existing: true });
    expect(await ensureMediaFeeAgreement("app-1", ["l1"], { query: existing.query })).toMatchObject({ created: false, reason: "already_exists" });
  });
  it("backfills files already sent when a lender's box is unchecked", async () => {
    const db = fakeDb({ category: "MEDIA", lenders: [{ id: "l1", has_broker_agreement: false }], sentApps: ["app-1"] });
    expect(await backfillFeeAgreementsForLender("l1", { query: db.query })).toEqual({ checked: 1, created: 1 });
  });
});
