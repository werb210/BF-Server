// BF_SERVER_v873_LENDER_API - the normal Send (dispatchToSelected) with lender API connections: a lender without a
// connection is emailed exactly as before; a connected lender gets the package by API instead of the email; an API
// failure falls back to Boreal's email package straight away and the fallback is logged on the lender API timeline.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const { sendLenderEmail } = vi.hoisted(() => ({ sendLenderEmail: vi.fn() }));
vi.mock("../../modules/lenderSubmissions/adapters/EmailAdapter.js", () => ({ sendLenderEmail }));
vi.mock("../../services/lenders/buildApplicationPackage.js", () => ({ buildApplicationPackage: vi.fn().mockResolvedValue({ zipBuffer: Buffer.from("zip") }) }));
vi.mock("../../services/lenders/loadPackageInputs.js", () => ({
  loadPackageInputs: vi.fn().mockResolvedValue({
    signedApplicationPdf: Buffer.from("%PDF signed"), creditSummaryPdf: null, additionalSignedDocs: [],
    documents: [{ category: "Bank Statements", files: [{ filename: "stmt.pdf", content: Buffer.from("%PDF doc") }] }],
    fields: [{ label: "Application Name", value: "Acme Ltd" }, { label: "Requested Amount", value: 50000 }],
  }),
}));
vi.mock("../../services/lenders/packageLink.js", () => ({
  prepareEmailDelivery: vi.fn().mockResolvedValue({ ok: true, bodyText: "package", bodyHtml: "<p>package</p>", attachments: [] }),
}));
vi.mock("../../services/email/resolveSignature.js", () => ({ resolveOwnerSignatureHtml: vi.fn().mockResolvedValue("") }));
vi.mock("../../services/fraud/fraudGuard.js", () => ({ assertApplicationNotFraud: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../services/productQuestions/sendGate.js", () => ({ assertProductQuestionsAnswered: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../modules/audit/audit.service.js", () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../modules/submissions/merchantGrowthSheet.js", () => ({ loadSheetRowData: vi.fn().mockResolvedValue({ company: "Acme Ltd", requestedAmount: "50000" }) }));

import { dispatchToSelected } from "../../services/lenders/dispatchToSelected.js";
import { sealSecrets } from "../store.js";
import type { HttpRequest } from "../http.js";

const KEY = "c".repeat(64);
const LENDER = { lender_id: "11111111-1111-1111-1111-111111111111", name: "Test Lender", submission_method: "email", submission_email: "deals@lender.example", api_endpoint: null, api_key_encrypted: null, google_sheet_id: null };

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-3333-3333-333333333333", lender_id: LENDER.lender_id, connector: "generic_rest", enabled: true, submit_by_api: true,
    email_fallback: true, poll_enabled: true, poll_interval_minutes: 30,
    config: { base_url: "https://api.lender.example", submit: { path: "/deals", field_map: { business_name: "company" }, external_id_path: "id" } },
    secrets_encrypted: sealSecrets({ api_key: "k-123" }, { LENDER_CREDENTIALS_ENCRYPTION_KEY: KEY } as NodeJS.ProcessEnv),
    secret_hints: {}, status_map: {}, ...overrides,
  };
}

function pool(conn: Record<string, unknown> | null) {
  return {
    query: vi.fn(answerBySql([
      [/FROM lender_connections c WHERE c.lender_id/, { rows: conn ? [conn] : [] }],
      [/INSERT INTO lender_api_submissions/, { rows: [{ id: "s1", attempts: 1 }] }],
      [/UPDATE lender_api_submissions SET status = \$3/, { rows: [{ id: "s1" }] }],
    ])),
  } as any;
}

describe("dispatchToSelected with lender API connections", () => {
  let calls: HttpRequest[];
  let answer: { status: number; text: string };
  beforeEach(async () => {
    vi.stubEnv("LENDER_CREDENTIALS_ENCRYPTION_KEY", KEY);
    sendLenderEmail.mockReset().mockResolvedValue({ ok: true, provider: "graph", deliveredTo: "deals@lender.example" });
    calls = [];
    answer = { status: 201, text: JSON.stringify({ id: "D-77" }) };
    // The connector modules are loaded lazily by dispatchToSelected: set the network stub on the instance it loads.
    (await import("../http.js")).setLenderHttpForTests(async (r) => { calls.push(r); return { status: answer.status, headers: {}, text: answer.text }; });
  });

  it("emails a lender with no connection exactly as today", async () => {
    const p = pool(null);
    const sent = await dispatchToSelected({ pool: p, applicationId: "app-1" }, [LENDER]);
    expect(sent).toEqual([LENDER.lender_id]);
    expect(sendLenderEmail).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    expect(callsMatching(p.query, /lender_api_events/)).toHaveLength(0);
  });

  it("sends a connected lender's package by API instead of the email", async () => {
    const p = pool(connection());
    const sent = await dispatchToSelected({ pool: p, applicationId: "app-1" }, [LENDER]);
    expect(sent).toEqual([LENDER.lender_id]);
    expect(sendLenderEmail).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.lender.example/deals");
    expect(calls[0]!.headers?.Authorization).toBe("Bearer k-123");
    expect(JSON.parse(String(calls[0]!.body))).toMatchObject({ business_name: "Acme Ltd" });
    const pkgRow = callsMatching(p.query, /INSERT INTO application_packages/)[0]![1] as unknown[];
    expect(pkgRow[2]).toBe("sent");
  });

  it("falls back to the email package when the API refuses, and logs the fallback", async () => {
    answer = { status: 503, text: "down" };
    const p = pool(connection());
    const sent = await dispatchToSelected({ pool: p, applicationId: "app-1" }, [LENDER]);
    expect(sent).toEqual([LENDER.lender_id]);
    expect(calls).toHaveLength(1);
    expect(sendLenderEmail).toHaveBeenCalledTimes(1);
    const kinds = callsMatching(p.query, /INSERT INTO lender_api_events/).map((c) => (c[1] as unknown[])[4]);
    expect(kinds).toEqual(expect.arrayContaining(["submit_attempt", "submit_failed", "email_fallback"]));
    const pkgRow = callsMatching(p.query, /INSERT INTO application_packages/)[0]![1] as unknown[];
    expect(pkgRow[2]).toBe("sent");
    expect(pkgRow[3]).toBeNull();
  });

  it("does not email when the connection has no email fallback; a retryable failure is scheduled for retry", async () => {
    answer = { status: 503, text: "down" };
    const p = pool(connection({ email_fallback: false }));
    const sent = await dispatchToSelected({ pool: p, applicationId: "app-1" }, [LENDER]);
    expect(sent).toEqual([]);
    expect(sendLenderEmail).not.toHaveBeenCalled();
    const upd = callsMatching(p.query, /SET status = \$2, last_error = \$3/)[0]![1] as unknown[];
    expect(upd[1]).toBe("retrying");
  });

  it("leaves a switched-off connection on the email path", async () => {
    const p = pool(connection({ enabled: false }));
    await dispatchToSelected({ pool: p, applicationId: "app-1" }, [LENDER]);
    expect(calls).toHaveLength(0);
    expect(sendLenderEmail).toHaveBeenCalledTimes(1);
  });

  it("keeps Merchant Growth on email until their API documentation arrives", async () => {
    const p = pool(connection({ connector: "merchant_growth" }));
    await dispatchToSelected({ pool: p, applicationId: "app-1" }, [LENDER]);
    expect(calls).toHaveLength(0);
    expect(sendLenderEmail).toHaveBeenCalledTimes(1);
  });
});
