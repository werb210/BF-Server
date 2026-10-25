// BF_SERVER_v852_CALC_QBO - signing the media fee agreement (SignNow, or marked signed by staff) queues the
// QuickBooks invoice; the hook does nothing at all while QuickBooks is not configured.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "../../../__tests__/helpers/answerBySql.js";
import { mountRouter, staffToken } from "../../../__tests__/helpers/staffRouterApp.js";
import { APP_ID, QBO_ENV } from "./qboFixtures.js";

const h = vi.hoisted(() => ({ query: vi.fn(), queue: vi.fn(), enqueue: vi.fn(async () => undefined) }));
vi.mock("../../../db.js", async () => ({ ...(await vi.importActual<any>("../../../db.js")), pool: { query: h.query, connect: async () => ({ query: h.query, release: () => {} }) }, dbQuery: h.query }));
vi.mock("../../../signnow/signnowClient.js", async () => ({
  ...(await vi.importActual<any>("../../../signnow/signnowClient.js")),
  isApiKeyConfigured: () => true,
  getDocumentGroupStatus: async () => ({ signed: true }),
}));

beforeEach(() => {
  h.query.mockReset();
  h.queue.mockReset();
  h.enqueue.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.doUnmock("../qboHooks.js");
  vi.doUnmock("../feeInvoices.js");
  for (const k of Object.keys(QBO_ENV)) delete process.env[k];
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("signing queues the QuickBooks invoice", () => {
  it("the client signs in SignNow (webhook / poller confirmation)", async () => {
    vi.doMock("../qboHooks.js", () => ({ queueQboFeeInvoice: h.queue }));
    h.query.mockImplementation(answerBySql([
      [/FROM media_fee_agreements WHERE application_id=\$1 LIMIT 1/, { rows: [{ id: "f1", application_id: APP_ID, status: "pending", signnow_group_id: "g1", signnow_doc_id: "d1", signer_is_applicant: true }] }],
      [/FROM documents WHERE application_id/, { rows: [{ id: "doc-1" }] }],
    ]));
    const { confirmFeeAgreementSigned } = await import("../../feeAgreement/mediaFeeAgreement.js");
    expect(await confirmFeeAgreementSigned(APP_ID)).toEqual({ signed: true });
    expect(h.queue).toHaveBeenCalledWith(APP_ID, "fee_agreement_signed");
  });

  it("staff mark it signed outside the portal", async () => {
    vi.doMock("../qboHooks.js", () => ({ queueQboFeeInvoice: h.queue }));
    h.query.mockImplementation(answerBySql([[/SELECT metadata FROM applications/, { rows: [{ metadata: {} }] }]]));
    const app = mountRouter((await import("../../../routes/portalFeeAgreement.js")).default, "/api/portal");
    const r = await request(app).post(`/api/portal/applications/${APP_ID}/fee-agreement/mark-signed`)
      .set("Authorization", "Bearer " + staffToken("Staff")).send({ note: "Signed by hand", feePercent: 1.5 });
    expect(r.status).toBe(200);
    expect(h.queue).toHaveBeenCalledWith(APP_ID, "fee_agreement_marked_signed");
  });
});

describe("the hook itself", () => {
  it("is a no-op without QuickBooks settings", async () => {
    vi.doMock("../feeInvoices.js", () => ({ enqueueFeeInvoiceSync: h.enqueue }));
    const { queueQboFeeInvoice } = await import("../qboHooks.js");
    queueQboFeeInvoice(APP_ID, "funded");
    await new Promise((r) => setTimeout(r, 20));
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("queues in the background once configured", async () => {
    Object.assign(process.env, QBO_ENV);
    vi.doMock("../feeInvoices.js", () => ({ enqueueFeeInvoiceSync: h.enqueue }));
    const { queueQboFeeInvoice } = await import("../qboHooks.js");
    queueQboFeeInvoice(APP_ID, "funded");
    await vi.waitFor(() => expect(h.enqueue).toHaveBeenCalledWith(APP_ID, "funded"));
  });
});
