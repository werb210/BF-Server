// BF_SERVER_BLOCK_v650_TEST2_FIX_PACK_v1
// The readiness receiver this pack also touched (src/routes/creditReadiness.ts) was unmounted
// and deleted in v789; its checks went with it. Everything below drives the live code.
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
// BF_SERVER_v809_SMS_UPDATES_CONSENT - this client ticked "Text me updates"; the consent gate has its own tests.
vi.mock("../services/smsUpdatesConsent.js", () => ({ smsUpdatesAllowed: async () => true }));
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { APP_ID, PARAM_GUARD_RULE, buildV1App, submitBaseRules } from "./helpers/v1AppsHarness.js";
import { docsNeededRules, wizardRequirements } from "./helpers/docsNeededHarness.js";

const h = vi.hoisted(() => ({
  queryMock: vi.fn(),
  logError: vi.fn(),
  notifyClient: vi.fn(async () => ({ channel: "sms" as string, error: undefined as string | undefined })),
  sendSms: vi.fn(async () => ({ sid: "SM1" })),
  termSheetSigned: vi.fn(async () => true),
  postBiHandoff: vi.fn(async () => ({ ok: true, biApplicationId: "bi-app", biPublicId: "BI-1", completionUrl: "https://bi.test/c/1" })),
  upsertCrmLead: vi.fn(async () => ({ id: "lead-1" })),
}));
vi.mock("../db.js", () => ({
  pool: { query: h.queryMock, connect: async () => ({ query: h.queryMock, release: () => undefined }) },
  runQuery: h.queryMock,
  dbQuery: h.queryMock,
}));
vi.mock("../observability/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../observability/logger.js")>()),
  logError: h.logError,
}));
vi.mock("../services/applicationCrmMirror.js", () => ({ mirrorApplicationToCrm: vi.fn(async () => undefined) }));
vi.mock("../services/notifications/notifyClient.js", () => ({ notifyClient: h.notifyClient }));
vi.mock("../modules/notifications/sms.service.js", () => ({ sendSms: h.sendSms }));
vi.mock("../services/termSheetSigned.js", () => ({ termSheetSigned: h.termSheetSigned }));
vi.mock("../services/biHandoff.js", () => ({ postBiHandoff: h.postBiHandoff }));
vi.mock("../services/biDocMirror.js", () => ({ mirrorApplicationDocsToBi: vi.fn(async () => ({ eligible: 0, mirrored: 0 })) }));
vi.mock("../modules/crm/leadUpsert.service.js", () => ({ upsertCrmLead: h.upsertCrmLead }));
vi.mock("../signnow/sba/sbaTrigger.js", () => ({ isSbaApplication: vi.fn(async () => false) }));
vi.mock("../services/documentSharing.js", () => ({
  shareFromOtherApplications: vi.fn(async () => 0),
  sharedDocumentsFor: vi.fn(async () => []),
}));

const PHONE_RULE: [RegExp, unknown] = [/SELECT c\.phone\s+FROM applications a\s+LEFT JOIN contacts c/, { rows: [{ phone: "+15875550100" }] }];

beforeEach(() => {
  vi.resetModules();
  h.queryMock.mockReset();
  h.logError.mockReset();
  h.notifyClient.mockClear();
  h.sendSms.mockClear();
  h.termSheetSigned.mockClear();
});

async function submit(app: Record<string, unknown>, extraRules: Array<[RegExp, unknown]> = []) {
  h.queryMock.mockImplementation(answerBySql([...extraRules, ...submitBaseRules()]));
  const res = await request(await buildV1App()).post(`/api/client/applications/${APP_ID}/submit`).send({ app });
  expect(res.status).toBe(200);
}

// BF_SERVER_v789_DEAD_CODE - the readiness-session TTL checks covered
// modules/readiness/readinessSession.service.ts, which nothing mounted; it was deleted.

describe("v650 - bfBuildWizardMetadata promotes Step 6 fields (C+D+E)", () => {
  async function patchedMetadata(body: Record<string, unknown>) {
    h.queryMock.mockImplementation(
      answerBySql([PARAM_GUARD_RULE, [/select id, name, pipeline_state/, { rows: [{ id: APP_ID, name: "Acme", metadata: {} }] }]]),
    );
    const res = await request(await buildV1App()).patch(`/api/client/applications/${APP_ID}`).send(body);
    expect(res.status).toBe(200);
    return (callsMatching(h.queryMock, /update applications\s+set name = \$2/)[0]![1] as unknown[])[3] as Record<string, any>;
  }

  it("promotes pgi_opt_in", async () => {
    // Step 6 sends it with the submit; the submit merges the promoted keys into metadata.
    await submit({ pgi_opt_in: "no", business: { companyName: "Acme" } });
    const meta = JSON.parse(String((callsMatching(h.queryMock, /requested_amount = COALESCE\(\$2, requested_amount\)/)[0]![1] as unknown[])[0]));
    expect(meta.pgi_opt_in).toBe("no");
  });

  it("promotes signature subobject", async () => {
    const meta = await patchedMetadata({ termsAccepted: true, typedSignature: "Ann Lee", signatureDate: "2026-10-01" });
    expect(meta.signature).toMatchObject({ termsAccepted: true, typedSignature: "Ann Lee", signatureDate: "2026-10-01", coApplicantSignature: null });
  });

  it("promotes requires_closing_cost_funding", async () => {
    expect((await patchedMetadata({ requires_closing_cost_funding: true })).requires_closing_cost_funding).toBe(true);
    h.queryMock.mockReset();
    expect((await patchedMetadata({ requiresClosingCostFunding: false })).requires_closing_cost_funding).toBe(false);
  });
});

describe("v650 - PGI handoff SMS + idempotent ready-message (A + J)", () => {
  const EXISTING = /SELECT id FROM communications_messages\s+WHERE application_id = \$1\s+AND staff_name = 'Boreal Insurance'/;
  const READY_INSERT = /INSERT INTO communications_messages[\s\S]+'Boreal Insurance', \$4, \$5/;

  it("ready-message INSERT is gated by existence check", async () => {
    await submit({ pgi_opt_in: "yes", business: { companyName: "Acme" } });
    expect(callsMatching(h.queryMock, EXISTING)[0]![1]).toEqual([APP_ID, "%https://bi.test/c/1%"]);
    const inserted = callsMatching(h.queryMock, READY_INSERT);
    expect(inserted).toHaveLength(1);
    expect((inserted[0]![1] as unknown[]).slice(1)).toEqual([APP_ID, expect.stringContaining("Your PGI application"), "Complete PGI Application", "https://bi.test/c/1"]);

    h.queryMock.mockReset();
    await submit({ pgi_opt_in: "yes", business: { companyName: "Acme" } }, [[EXISTING, { rows: [{ id: "msg-1" }] }]]);
    expect(callsMatching(h.queryMock, READY_INSERT)).toHaveLength(0);
  });

  it("Twilio sendSms call per leg once the term sheet is signed", async () => {
    await submit({ pgi_opt_in: "yes", business: { companyName: "Acme" } }, [PHONE_RULE]);
    expect(h.sendSms).toHaveBeenCalledWith({ to: "+15875550100", message: expect.stringMatching(/^Boreal Insurance: your PGI application .* https:\/\/bi\.test\/c\/1$/) });
  });

  it("an SMS failure is logged and does not fail the submit", async () => {
    h.sendSms.mockRejectedValueOnce(new Error("twilio down"));
    await submit({ pgi_opt_in: "yes", business: { companyName: "Acme" } }, [PHONE_RULE]);
    expect(h.logError).toHaveBeenCalledWith("bi_handoff_sms_failed_nonfatal", expect.objectContaining({ applicationId: APP_ID, role: "primary", error: "twilio down" }));
  });
});

describe("v650 - missing-docs SMS on submit (B)", () => {
  it("documentsDeferred path sends an SMS", async () => {
    await submit({ documentsDeferred: true, business: { companyName: "Acme" } }, [PHONE_RULE]);
    expect(h.notifyClient).toHaveBeenCalledWith(expect.objectContaining({
      phone: "+15875550100",
      kind: "documents_remaining",
      sms: expect.stringContaining("upload your remaining documents"),
    }));
  });

  it("no deferral, no SMS", async () => {
    await submit({ business: { companyName: "Acme" } }, [PHONE_RULE]);
    expect(h.notifyClient).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "documents_remaining" }));
  });

  it("an undelivered SMS is logged as non-fatal", async () => {
    h.notifyClient.mockResolvedValueOnce({ channel: "none", error: "no_route" });
    await submit({ documents_deferred: true, business: { companyName: "Acme" } }, [PHONE_RULE]);
    await vi.waitFor(() => expect(h.logError).toHaveBeenCalledWith("missing_docs_sms_failed_nonfatal", expect.objectContaining({ applicationId: APP_ID, error: "no_route" })));
  });
});

// BF_SERVER_BLOCK_v580 - v698 replaced the category + amount-window union: with no product on
// the file, the documents come from the requirements the wizard stored on the application.
describe("v650 - DocPicker still has documents when lender_product_id is NULL (K, now v698)", () => {
  it("falls back to the wizard-stored product requirements", async () => {
    h.queryMock.mockImplementation(answerBySql(docsNeededRules({ productDocs: null, metadata: wizardRequirements([{ document_type: "Void cheque", required: true }, "Articles of incorporation"]) })));
    const { computeOutstandingDocs } = await import("../routes/clientDocumentsNeeded.js");
    const out = await computeOutstandingDocs(APP_ID);
    expect(out.required.map((d) => d.document_type)).toEqual(["Void cheque", "Articles of incorporation"]);
    expect(out.stillNeeded).toHaveLength(2);
  });
});
