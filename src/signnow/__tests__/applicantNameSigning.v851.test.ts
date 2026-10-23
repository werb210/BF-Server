// BF_SERVER_v851_APPLICANT_NAME - signing uses the real applicant name (CRM fallback + write-back) and never goes
// out as "Unknown (application started)".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  buildPdf: vi.fn(async (_inputs: unknown) => new Uint8Array([37, 80, 68, 70])),
  upload: vi.fn(async () => ({ blobName: "b", url: "u" })),
  sendInvite: vi.fn(async () => ({})),
}));
vi.mock("../../db.js", () => ({ dbQuery: h.dbQuery, pool: { query: h.dbQuery }, runQuery: h.dbQuery, query: h.dbQuery }));
vi.mock("../signnowClient.js", () => ({
  isApiKeyConfigured: () => true,
  uploadDocument: vi.fn(async () => ({ documentId: "doc-1" })),
  sendInvite: h.sendInvite,
  getSignerInviteComplete: vi.fn(async () => false),
  createEmbeddedGroupLink: vi.fn(),
}));
vi.mock("../pdfBuilder.js", () => ({ buildApplicationPdf: h.buildPdf }));
vi.mock("../accordPdfBuilder.js", () => ({ buildAccordPdf: vi.fn() }));
vi.mock("../blobStorage.js", () => ({ uploadSignedApplicationPdf: h.upload }));
vi.mock("../pnwSigning.js", () => ({ pnwSigningSatisfiedForAppSigning: vi.fn(async () => true) }));
vi.mock("../sba/sbaTrigger.js", () => ({ isSbaApplication: vi.fn(async () => false) }));
vi.mock("../../routes/clientDocumentsNeeded.js", () => ({ computeOutstandingDocs: vi.fn(async () => ({ stillNeeded: [], rejected: [], required: [] })) }));

import { loadApplicationForPdf, sendApplicationForSignature } from "../sendApplicationForSignature.js";
import { getOrCreateEmbeddedSigningSession } from "../embeddedSigningSession.js";
import { describeOwner1Notice } from "../ownerSigningNotice.js";
import { maybeStartCreditSummaryAndSign } from "../../services/submission/orchestrator.js";

const APP = "6a1b2c3d-0000-4000-8000-000000000851";
const PLACEHOLDER_APPLICANT = { firstName: "Unknown", lastName: "(application started)", email: "jordan@rivers.co", phone: "7805550100" };
const APP_ROW_SQL = /SELECT id, name, requested_amount, product_category, metadata FROM applications/;
const RESOLVE_SQL = /AS v851_applicant/;
const WRITE_SQL = /UPDATE applications[\s\S]*'\{applicant\}'/;
const jordan = { v851_applicant: PLACEHOLDER_APPLICANT, v851_contact_first: "Jordan", v851_contact_last: "Rivers", v851_contact_name: "Jordan Rivers" };
const nobody = { v851_applicant: PLACEHOLDER_APPLICANT, v851_contact_first: "Unknown", v851_contact_last: "(application started)", v851_contact_name: "Unknown (application started)" };

function answer(rules: SqlRule[]) {
  h.dbQuery.mockImplementation(answerBySql(rules));
}

beforeEach(() => {
  h.dbQuery.mockReset();
  h.buildPdf.mockClear();
  h.upload.mockClear();
  h.sendInvite.mockClear();
  delete process.env.SIGNNOW_STUB_MODE;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("v851 signing name", () => {
  it("a placeholder applicant signs under the corrected CRM name, written back into metadata.applicant", async () => {
    answer([[APP_ROW_SQL, { rows: [{ id: APP, metadata: { applicant: PLACEHOLDER_APPLICANT } }] }], [RESOLVE_SQL, { rows: [jordan] }]]);
    const inputs = await loadApplicationForPdf(APP);
    expect(inputs.owners[0]).toMatchObject({ firstName: "Jordan", lastName: "Rivers" });
    expect(inputs.applicantName).toBe("Jordan Rivers");
    expect(callsMatching(h.dbQuery, WRITE_SQL)[0][1]).toEqual([APP, "Jordan", "Rivers", "Jordan Rivers"]);
  });

  it("an application with its own real name is unchanged and reads nothing extra", async () => {
    answer([[APP_ROW_SQL, { rows: [{ id: APP, metadata: { applicant: { firstName: "Pat", lastName: "Lee", email: "p@l.co" } } }] }]]);
    const inputs = await loadApplicationForPdf(APP);
    expect(inputs.applicantName).toBe("Pat Lee");
    expect(callsMatching(h.dbQuery, RESOLVE_SQL)).toHaveLength(0);
  });

  it("uses an application's real fullName when split name fields are absent", async () => {
    answer([[APP_ROW_SQL, { rows: [{ id: APP, metadata: { applicant: { fullName: "  Jordan   Rivers " } } }] }]]);
    const inputs = await loadApplicationForPdf(APP);
    expect(inputs.owners[0]).toMatchObject({ firstName: "Jordan", lastName: "Rivers" });
    expect(inputs.applicantName).toBe("Jordan Rivers");
    expect(callsMatching(h.dbQuery, RESOLVE_SQL)).toHaveLength(0);
  });

  it("drops a placeholder name part beside a real applicant name without changing source metadata", async () => {
    const applicant = { firstName: "Unknown", lastName: "Rivers" };
    answer([[APP_ROW_SQL, { rows: [{ id: APP, metadata: { applicant } }] }]]);
    const inputs = await loadApplicationForPdf(APP);
    expect(inputs.owners[0]).toMatchObject({ firstName: null, lastName: "Rivers" });
    expect(inputs.applicantName).toBe("Rivers");
    expect(applicant).toEqual({ firstName: "Unknown", lastName: "Rivers" });
    expect(callsMatching(h.dbQuery, RESOLVE_SQL)).toHaveLength(0);
  });

  it("with no real name anywhere the owner name is blank and the legacy send is refused, never sent to Unknown", async () => {
    answer([[APP_ROW_SQL, { rows: [{ id: APP, metadata: { applicant: PLACEHOLDER_APPLICANT } }] }], [RESOLVE_SQL, { rows: [nobody] }]]);
    const inputs = await loadApplicationForPdf(APP);
    expect(inputs.owners[0].firstName).toBeNull();
    expect(inputs.owners[0].lastName).toBeNull();
    expect(inputs.applicantName).toBeNull();
    const r = await sendApplicationForSignature({ applicationId: APP });
    expect(r).toEqual({ ok: false, mode: "skipped", reason: "applicant_name_missing" });
    expect(h.buildPdf).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.sendInvite).not.toHaveBeenCalled();
    expect(callsMatching(h.dbQuery, WRITE_SQL)).toHaveLength(0);
  });

  it("the embedded signing group does not start without a name", async () => {
    answer([
      [/finalized_count/, { rows: [{ signnow_app_signed_at: null, metadata: {}, finalized_count: "1" }] }],
      [APP_ROW_SQL, { rows: [{ id: APP, metadata: { applicant: PLACEHOLDER_APPLICANT } }] }],
      [RESOLVE_SQL, { rows: [nobody] }],
    ]);
    expect(await getOrCreateEmbeddedSigningSession(APP)).toEqual({ status: "not_ready", reason: "applicant_name_missing" });
    expect(h.buildPdf).not.toHaveBeenCalled();
  });

  it("the Owner 1 signing notice names the real person, not the placeholder", async () => {
    answer([
      [/metadata->'applicant'->>'firstName' AS first/, { rows: [{ first: "Unknown", last: "(application started)", phone: "7805550100", sms_at: null }] }],
      [RESOLVE_SQL, { rows: [jordan] }],
    ]);
    const n = await describeOwner1Notice(APP);
    expect(n.name).toBe("Jordan Rivers");
  });

  it("automatic signing logs and skips when there is no real name (the chain is not claimed)", async () => {
    const query = vi.fn(answerBySql([
      ["application_tasks", { rows: [{ open_count: "0" }] }],
      ["application_lender_selections", { rows: [{ finalized_at: "2026-10-01" }] }],
      [RESOLVE_SQL, { rows: [nobody] }],
    ]));
    const r = await maybeStartCreditSummaryAndSign({ pool: { query } as any, applicationId: APP });
    expect(r).toEqual({ fired: false, reason: "applicant_name_missing" });
    expect(callsMatching(query, "submission_chain_started_at = NOW()")).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("applicant name missing"));
  });
});
