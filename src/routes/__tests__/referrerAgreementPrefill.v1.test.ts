// BF_SERVER_REFERRER_AGREEMENT_PREFILL_v1
// Every field captured at signup reaches the referral agreement the referrer signs.
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";
import { pdfContent } from "../../__tests__/helpers/pdfContent.js";

const h = vi.hoisted(() => ({ queryMock: vi.fn(), uploads: [] as Array<{ pdf: Uint8Array; name: string }> }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: h.queryMock } };
});
vi.mock("../../signnow/signnowClient.js", async (orig) => ({
  ...(await orig<typeof import("../../signnow/signnowClient.js")>()),
  isApiKeyConfigured: () => true,
  uploadDocumentWithFieldExtract: async (pdf: Uint8Array, name: string) => { h.uploads.push({ pdf, name }); return { documentId: "doc-1" }; },
  createDocumentGroup: async () => ({ groupId: "grp-1" }),
  createEmbeddedGroupInvite: async () => ({ inviteId: "inv-1" }),
  createEmbeddedGroupLink: async () => ({ url: "https://signnow.test/sign" }),
}));

import { prefillTextFields } from "../../signnow/signnowClient.js";
import { buildReferrerAgreementPdf } from "../../signnow/referrerAgreementPdfBuilder.js";
import { createReferrerAgreementSession } from "../../modules/referrals/referrerAgreement.service.js";
import referrerSelfRouter from "../referrerSelf.js";

const PROFILE = {
  fullName: "Rae Ferrer", company: "Ferrer Co", email: "rae@example.test", phone: "+15875550177",
  street: "2 Side St", city: "Edmonton", province: "AB", postal: "T5J 0A1", etransfer: "pay@example.test",
};
const VALUES = ["Rae Ferrer", "Ferrer Co", "rae@example.test", "+15875550177", "2 Side St", "Edmonton AB T5J 0A1", "pay@example.test"];

beforeEach(() => {
  h.uploads.length = 0;
  h.queryMock.mockReset();
  h.queryMock.mockImplementation(answerBySql([]));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("referrer agreement prefill", () => {
  it("client exposes prefillTextFields hitting the SignNow prefill endpoint", async () => {
    vi.stubEnv("SIGNNOW_API_KEY", "sn-test-key");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await prefillTextFields("doc 1", [{ name: "Full name", value: "  Rae Ferrer " }, { name: "Company", value: "" }, { name: "Phone", value: null }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v2\/documents\/doc%201\/prefill-texts$/);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ fields: [{ field_name: "Full name", prefilled_text: "Rae Ferrer" }] });
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer sn-test-key");

    fetchMock.mockClear();
    await prefillTextFields("doc 1", [{ name: "Company", value: "  " }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // BF_SERVER_REPAIR_STALE_TESTS_v1 - the labels moved from the service into the PDF builder, which now
  // prints them. Every signup field must reach the agreement.
  it("the generated PDF carries every field captured at signup", async () => {
    const { text } = pdfContent(await buildReferrerAgreementPdf({ fullName: "X" }));
    for (const label of ["Full name", "Company", "Email", "Phone", "Street address", "Payout (e-Transfer) email"]) {
      expect(text).toContain(label);
    }
  });

  it("the service passes every signup value into the builder", async () => {
    await createReferrerAgreementSession({ referrerId: "r-1", ...PROFILE });
    expect(h.uploads).toHaveLength(1);
    const { text } = pdfContent(h.uploads[0].pdf);
    for (const v of VALUES) expect(text).toContain(v);
  });

  it("signup passes profile data to the session", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/referrer", referrerSelfRouter);
    const r = await request(app).post("/api/referrer/signup").send({
      full_name: PROFILE.fullName, company_name: PROFILE.company, email: PROFILE.email, phone: PROFILE.phone,
      street: PROFILE.street, city: PROFILE.city, province: PROFILE.province, postal_code: PROFILE.postal, etransfer_email: PROFILE.etransfer,
    });
    expect(r.status).toBe(201);
    expect(h.uploads).toHaveLength(1);
    const { text } = pdfContent(h.uploads[0].pdf);
    for (const v of VALUES) expect(text).toContain(v);
  });
});
