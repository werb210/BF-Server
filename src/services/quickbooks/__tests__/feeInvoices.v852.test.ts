// BF_SERVER_v852_CALC_QBO - QuickBooks fee invoices: invoice at signing, follow the funded amount and mark paid,
// idempotency, failures and backoff, token renewal with rotation, the worker's discovery. The database is faked by
// SQL content (answerBySql) and Intuit by a fake fetch: nothing reaches the real Intuit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, type SqlRule } from "../../../__tests__/helpers/answerBySql.js";
import { APP_ID, QBO_ENV, connectionRow, fakeIntuit } from "./qboFixtures.js";
import { decryptToken } from "../qboCrypto.js";
import {
  backoffMs, enqueueFeeInvoiceSync, feeAmountFor, feeLineDescription, isFundedApp, runFeeInvoiceTick, syncFeeInvoice,
} from "../feeInvoices.js";
import { qboApiBase, qboConfigured, qboMissingSettings, qboRedirectUri, qboReturnUrl } from "../qboConfig.js";
import { encryptToken } from "../qboCrypto.js";

const query = vi.fn();

type World = {
  agreement?: Record<string, unknown> | null;
  app?: Record<string, unknown> | null;
  invoice?: Record<string, unknown> | null;
  connection?: Record<string, unknown> | null;
  taxCode?: string | null;
};

function world(w: World, extra: SqlRule[] = []) {
  const agreement = w.agreement === undefined ? { status: "signed", fee_percent: null, fee_amount: null, signer_name: "Ada Client", signer_email: "ada@client.example" } : w.agreement;
  const app = w.app === undefined ? { id: APP_ID, name: "Northern Lights Films", requested_amount: "250000", funded_amount: null, funded_at: null, pipeline_state: "Off to lender", metadata: { business: { legalName: "Northern Lights Films Ltd." } } } : w.app;
  const connection = w.connection === undefined ? connectionRow() : w.connection;
  query.mockImplementation(answerBySql([
    ...extra,
    [/FROM media_fee_agreements WHERE application_id/, { rows: agreement ? [agreement] : [] }],
    [/FROM applications WHERE id::text/, { rows: app ? [app] : [] }],
    [/FROM qbo_fee_invoices WHERE application_id/, { rows: w.invoice ? [w.invoice] : [] }],
    [/FROM qbo_connections WHERE id/, { rows: connection ? [connection] : [] }],
    [/SELECT value FROM settings WHERE key/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === "quickbooks.tax_code" && w.taxCode ? [{ value: w.taxCode }] : [] })],
    [/INSERT INTO qbo_fee_invoices \(application_id, sync_state, lease_until/, { rows: [{ application_id: APP_ID }] }],
  ]));
}

const deps = (fetchImpl: any) => ({ db: { query }, fetchImpl, env: QBO_ENV });

beforeEach(() => {
  query.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("settings and fee maths", () => {
  it("is off until all three required settings are set, and names what is missing", () => {
    expect(qboConfigured({})).toBe(false);
    expect(qboMissingSettings({ QBO_CLIENT_ID: "x", QBO_TOKEN_ENCRYPTION_KEY: "short" })).toEqual(["QBO_CLIENT_SECRET", "QBO_TOKEN_ENCRYPTION_KEY"]);
    expect(qboConfigured(QBO_ENV)).toBe(true);
  });

  it("uses the Intuit sandbox unless QBO_ENVIRONMENT=production, and the default callback", () => {
    expect(qboApiBase({})).toBe("https://sandbox-quickbooks.api.intuit.com");
    expect(qboApiBase({ QBO_ENVIRONMENT: "production" })).toBe("https://quickbooks.api.intuit.com");
    expect(qboRedirectUri({})).toBe("https://server.boreal.financial/api/quickbooks/oauth/callback");
    expect(qboRedirectUri({ PUBLIC_BASE_URL: "https://staging.example/" })).toBe("https://staging.example/api/quickbooks/oauth/callback");
    expect(qboReturnUrl("connected", {})).toBe("https://staff.boreal.financial/settings/quickbooks?quickbooks=connected");
  });

  it("encrypts tokens and refuses another key", () => {
    const enc = encryptToken("secret-refresh", QBO_ENV);
    expect(enc).not.toContain("secret-refresh");
    expect(decryptToken(enc, QBO_ENV)).toBe("secret-refresh");
    expect(() => decryptToken(enc, { QBO_TOKEN_ENCRYPTION_KEY: "z".repeat(40) })).toThrow();
  });

  it("2% of the amount by default, the agreed percent or fixed fee otherwise", () => {
    expect(feeAmountFor({ percent: null, fixed: null }, 250000)).toBe(5000);
    expect(feeAmountFor({ percent: 1.5, fixed: null }, 123456.78)).toBe(1851.85);
    expect(feeAmountFor({ percent: null, fixed: 7500 }, 250000)).toBe(7500);
    expect(feeAmountFor({ percent: null, fixed: null }, null)).toBeNull();
    expect(feeLineDescription({ percent: null, fixed: null })).toBe("Media funding fee (2% of funding)");
    expect(feeLineDescription({ percent: 1.5, fixed: null })).toBe("Media funding fee (1.5% of funding)");
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(4)).toBe(8 * 60_000);
    expect(backoffMs(20)).toBe(360 * 60_000);
    expect(isFundedApp({ funded_at: null, pipeline_state: "Accepted" })).toBe(true);
    expect(isFundedApp({ funded_at: null, pipeline_state: "Off to lender" })).toBe(false);
  });
});

describe("signed agreement -> invoice", () => {
  it("creates the customer, the fee item and one invoice line at 2% of the requested amount (sandbox)", async () => {
    world({ taxCode: "5" });
    const intuit = fakeIntuit();
    const out = await syncFeeInvoice(APP_ID, deps(intuit.fetchImpl));
    expect(out).toEqual({ ok: true, action: "invoice_created" });

    expect(intuit.calls.every((c) => c.url.startsWith("https://sandbox-quickbooks.api.intuit.com/v3/company/9341452/"))).toBe(true);
    const customer = intuit.calls.find((c) => c.method === "POST" && c.path.endsWith("/customer"))!;
    expect(customer.body).toMatchObject({ DisplayName: "Northern Lights Films Ltd.", CompanyName: "Northern Lights Films Ltd.", PrimaryEmailAddr: { Address: "ada@client.example" } });
    const invoice = intuit.calls.find((c) => c.method === "POST" && c.path.endsWith("/invoice"))!;
    expect(invoice.query.get("requestid")).toBe("bf-fee-inv-" + APP_ID);
    expect(invoice.body.CustomerRef).toEqual({ value: "58" });
    expect(invoice.body.Line).toHaveLength(1);
    expect(invoice.body.Line[0]).toMatchObject({ Amount: 5000, Description: "Media funding fee (2% of funding)", SalesItemLineDetail: { ItemRef: { value: "21" }, TaxCodeRef: { value: "5" } } });
    expect(invoice.body.GlobalTaxCalculation).toBe("TaxExcluded");

    const saved = callsMatching(query, /SET qbo_invoice_id = \$2/)[0]![1] as unknown[];
    expect(saved).toEqual([APP_ID, "130", "1042", "58", 5000]);
    expect(callsMatching(query, /SET sync_state = 'ok'/)).toHaveLength(1);
    // the item id is remembered for this company file
    expect(callsMatching(query, /INSERT INTO settings/).some((c) => (c[1] as unknown[])[1] === "9341452:21")).toBe(true);
  });

  it("reuses a customer found by email and leaves the tax code off when none is set", async () => {
    world({});
    const intuit = fakeIntuit([(c) => (c.path.endsWith("/query") && /PrimaryEmailAddr = 'ada@client.example'/.test(c.query.get("query") ?? "") ? { body: { QueryResponse: { Customer: [{ Id: "77" }] } } } : undefined)]);
    await syncFeeInvoice(APP_ID, deps(intuit.fetchImpl));
    expect(intuit.calls.some((c) => c.method === "POST" && c.path.endsWith("/customer"))).toBe(false);
    const invoice = intuit.calls.find((c) => c.method === "POST" && c.path.endsWith("/invoice"))!;
    expect(invoice.body.CustomerRef).toEqual({ value: "77" });
    expect(invoice.body.Line[0].SalesItemLineDetail.TaxCodeRef).toBeUndefined();
  });

  it("invoices an agreed fixed fee as that amount", async () => {
    world({ agreement: { status: "signed", fee_percent: null, fee_amount: "7500.00", signer_name: null, signer_email: null } });
    const intuit = fakeIntuit();
    await syncFeeInvoice(APP_ID, deps(intuit.fetchImpl));
    const invoice = intuit.calls.find((c) => c.method === "POST" && c.path.endsWith("/invoice"))!;
    expect(invoice.body.Line[0]).toMatchObject({ Amount: 7500, Description: "Media funding fee (fixed fee)" });
  });

  it("does nothing before the agreement is signed, or once the invoice is paid", async () => {
    world({ agreement: { status: "pending", fee_percent: null, fee_amount: null, signer_name: null, signer_email: null } });
    let intuit = fakeIntuit();
    expect((await syncFeeInvoice(APP_ID, deps(intuit.fetchImpl))).action).toBe("agreement_not_signed");
    expect(intuit.calls).toHaveLength(0);

    world({ invoice: { application_id: APP_ID, qbo_invoice_id: "130", doc_number: "1042", qbo_customer_id: "58", amount: "5000", status: "paid", qbo_payment_id: "200", sync_state: "queued", attempts: 0, last_error: null, synced_at: null } });
    intuit = fakeIntuit();
    expect((await syncFeeInvoice(APP_ID, deps(intuit.fetchImpl))).action).toBe("already_paid");
    expect(intuit.calls).toHaveLength(0);
  });

  it("another sync holding the file's lease is left alone", async () => {
    world({}, [[/INSERT INTO qbo_fee_invoices \(application_id, sync_state, lease_until/, { rows: [] }]]);
    const intuit = fakeIntuit();
    expect((await syncFeeInvoice(APP_ID, deps(intuit.fetchImpl))).action).toBe("busy");
    expect(intuit.calls).toHaveLength(0);
  });
});

describe("funded -> funded amount and paid", () => {
  const open = { application_id: APP_ID, qbo_invoice_id: "130", doc_number: "1042", qbo_customer_id: "58", amount: "5000.00", status: "open", qbo_payment_id: null, sync_state: "queued", attempts: 0, last_error: null, synced_at: null };

  it("changes the invoice to the funded amount, then records a payment that marks it paid", async () => {
    world({ invoice: open, app: { id: APP_ID, name: "Northern Lights Films", requested_amount: "250000", funded_amount: "200000", funded_at: "2026-10-20T15:00:00Z", pipeline_state: "Accepted", metadata: {} } });
    const intuit = fakeIntuit();
    const out = await syncFeeInvoice(APP_ID, deps(intuit.fetchImpl));
    expect(out).toEqual({ ok: true, action: "paid" });
    const update = intuit.calls.find((c) => c.method === "POST" && c.path.endsWith("/invoice"))!;
    expect(update.body).toMatchObject({ Id: "130", SyncToken: "3", sparse: true });
    expect(update.body.Line[0]).toMatchObject({ Amount: 4000, Description: "Media funding fee (2% of funding)", SalesItemLineDetail: { ItemRef: { value: "21" } } });
    const payment = intuit.calls.find((c) => c.method === "POST" && c.path.endsWith("/payment"))!;
    expect(payment.query.get("requestid")).toBe("bf-fee-pay-" + APP_ID);
    expect(payment.body).toMatchObject({ CustomerRef: { value: "58" }, TotalAmt: 4000, Line: [{ Amount: 4000, LinkedTxn: [{ TxnId: "130", TxnType: "Invoice" }] }] });
    expect(callsMatching(query, /SET amount = \$2/)[0]![1]).toEqual([APP_ID, 4000]);
    expect(callsMatching(query, /SET status = 'paid'/)[0]![1]).toEqual([APP_ID, "200"]);
  });

  it("keeps the invoice when the funded amount gives the same fee and only records the payment", async () => {
    world({ invoice: open, app: { id: APP_ID, name: "N", requested_amount: "250000", funded_amount: "250000", funded_at: "2026-10-20T15:00:00Z", pipeline_state: "Accepted", metadata: {} } });
    const intuit = fakeIntuit();
    await syncFeeInvoice(APP_ID, deps(intuit.fetchImpl));
    expect(intuit.calls.filter((c) => c.method === "POST" && c.path.endsWith("/invoice"))).toHaveLength(0);
    expect(intuit.calls.find((c) => c.path.endsWith("/payment"))!.body.TotalAmt).toBe(5000);
  });
});

describe("failures, retries and tokens", () => {
  it("a QuickBooks error is logged, counted and retried later with backoff", async () => {
    world({});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const intuit = fakeIntuit([(c) => (c.method === "POST" && c.path.endsWith("/invoice") ? { status: 400, body: { Fault: { Error: [{ Message: "Business Validation Error", Detail: "Make sure all your transactions have a GST/HST rate", code: "6000" }] } } } : undefined)]);
    const out = await syncFeeInvoice(APP_ID, deps(intuit.fetchImpl));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/GST\/HST/);
    const failed = callsMatching(query, /SET sync_state = 'failed', attempts = attempts \+ 1/);
    expect(failed).toHaveLength(1);
    expect(String(failed[0]![0])).toMatch(/make_interval\(mins => LEAST\(360/);
    expect(err).toHaveBeenCalledWith(expect.objectContaining({ event: "qbo_fee_invoice_sync_failed", applicationId: APP_ID, code: "6000" }));
  });

  it("not connected is a failure to retry, without calling Intuit", async () => {
    world({ connection: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const intuit = fakeIntuit();
    const out = await syncFeeInvoice(APP_ID, deps(intuit.fetchImpl));
    expect(out).toMatchObject({ ok: false, action: "failed" });
    expect(intuit.calls).toHaveLength(0);
  });

  it("renews an access token about to expire and stores the rotated refresh token, encrypted", async () => {
    world({ connection: connectionRow({ access_expires_at: new Date(Date.now() + 60_000).toISOString() }) });
    const intuit = fakeIntuit();
    await syncFeeInvoice(APP_ID, deps(intuit.fetchImpl));
    const token = intuit.calls.find((c) => c.url.startsWith("https://oauth.platform.intuit.com/"))!;
    expect(token.body).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1" });
    const saved = callsMatching(query, /UPDATE qbo_connections SET access_token_enc/)[0]![1] as string[];
    expect(saved[1]).not.toContain("access-2");
    expect(decryptToken(saved[1]!, QBO_ENV)).toBe("access-2");
    expect(decryptToken(saved[2]!, QBO_ENV)).toBe("refresh-2");
    const api = intuit.calls.find((c) => c.path.endsWith("/invoice"))!;
    expect(api).toBeTruthy();
  });

  it("with QuickBooks not configured nothing is queued and nothing is synced", async () => {
    world({});
    await enqueueFeeInvoiceSync(APP_ID, "fee_agreement_signed", { db: { query }, env: {} });
    expect(query).not.toHaveBeenCalled();
    expect((await syncFeeInvoice(APP_ID, { db: { query }, env: {} })).action).toBe("not_configured");
    expect(await runFeeInvoiceTick({ db: { query }, env: {} })).toEqual({ queued: 0, synced: 0, failed: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  it("queues a signed file (a paid invoice is never re-queued)", async () => {
    world({});
    await enqueueFeeInvoiceSync(APP_ID, "fee_agreement_signed", { db: { query }, env: QBO_ENV });
    const q = callsMatching(query, /INSERT INTO qbo_fee_invoices \(application_id, sync_state, next_attempt_at, attempts/);
    expect(q).toHaveLength(1);
    expect(String(q[0]![0])).toMatch(/WHERE qbo_fee_invoices.status <> 'paid'/);
  });
});

describe("worker tick", () => {
  it("queues new work (signed since QuickBooks was connected, newly funded) and syncs what is due", async () => {
    world({}, [
      [/SELECT application_id FROM qbo_fee_invoices\s+WHERE sync_state IN/, { rows: [{ application_id: APP_ID }] }],
      [/INSERT INTO qbo_fee_invoices \(application_id, sync_state, next_attempt_at, created_at, updated_at\)\s+SELECT/, { rows: [{ application_id: APP_ID }] }],
    ]);
    const intuit = fakeIntuit();
    const out = await runFeeInvoiceTick(deps(intuit.fetchImpl));
    expect(out).toEqual({ queued: 1, synced: 1, failed: 0 });
    const discover = callsMatching(query, /FROM media_fee_agreements m/)[0]![0] as string;
    expect(discover).toMatch(/m.signed_at >= COALESCE\(c.first_connected_at, c.connected_at\)/);
    const due = callsMatching(query, /WHERE sync_state IN \('queued', 'failed'\) AND attempts < \$1/)[0]![1];
    expect(due).toEqual([8, 10]);
  });

  it("does nothing while QuickBooks is not connected", async () => {
    world({ connection: null });
    const intuit = fakeIntuit();
    expect(await runFeeInvoiceTick(deps(intuit.fetchImpl))).toEqual({ queued: 0, synced: 0, failed: 0 });
    expect(callsMatching(query, /FROM media_fee_agreements m/)).toHaveLength(0);
  });
});
