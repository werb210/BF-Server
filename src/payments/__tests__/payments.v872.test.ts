// BF_SERVER_v872_PAYMENTS - payment links for broker fees on Boreal's own Stripe account: settings, signatures, the
// Checkout session, the webhook statuses, the timeline, and the QuickBooks fee invoice marked paid.
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

// QuickBooks is stubbed at its client: the invoice read and the payment call are checked, never sent.
const qbo = vi.hoisted(() => ({ getConnection: vi.fn(), qboRequest: vi.fn() }));
vi.mock("../../services/quickbooks/qboClient.js", async (orig) => ({ ...(await orig<any>()), getConnection: qbo.getConnection, qboRequest: qbo.qboRequest }));
import {
  formEncode, setStripeFetchForTests, signStripePayload, stripeConfig, stripeConfigProblem, verifyStripeSignature, type StripeConfig,
} from "../stripe.js";
import { handleStripeEvent, linkMessage, linkView, openCheckout, recordInQuickBooks, sendLink, suggestedFee, validateCreate, type LinkRow } from "../paymentLinks.js";

const CFG: StripeConfig = { secretKey: "sk_test_x", webhookSecret: "whsec_test", livemode: false };
const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function link(over: Partial<LinkRow> = {}): LinkRow {
  return {
    id: LINK, token: "t".repeat(32), application_id: APP, contact_id: CONTACT, silo: "BF", description: "Broker fee", amount_cents: 250000,
    currency: "cad", methods: ["card", "acss_debit"], status: "open", livemode: false, checkout_session_id: null, checkout_url: null,
    checkout_expires_at: null, checkout_count: 0, payment_intent_id: null, payment_method_type: null, amount_received_cents: null, paid_at: null,
    processing_at: null, failed_at: null, failure_message: null, cancelled_at: null, sent_channels: [], sent_at: null,
    expires_at: new Date(Date.now() + 86_400_000 * 10), quickbooks_status: "none", quickbooks_payment_id: null, quickbooks_error: null,
    quickbooks_attempts: 0, created_by: null, created_at: new Date(), updated_at: new Date(), ...over,
  };
}

afterEach(() => setStripeFetchForTests(null));

describe("settings", () => {
  it("names each missing setting, never a value; test and live keys are told apart", () => {
    expect(stripeConfigProblem({})).toContain("STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET");
    expect(stripeConfigProblem({ STRIPE_SECRET_KEY: "sk_live_secret", STRIPE_WEBHOOK_SECRET: "" })).not.toContain("sk_live_secret");
    expect(stripeConfigProblem({ STRIPE_SECRET_KEY: "a", STRIPE_WEBHOOK_SECRET: "b" })).toBeNull();
    expect(stripeConfig({ STRIPE_SECRET_KEY: "sk_live_1", STRIPE_WEBHOOK_SECRET: "w" })?.livemode).toBe(true);
    expect(stripeConfig({ STRIPE_SECRET_KEY: "rk_test_1", STRIPE_WEBHOOK_SECRET: "w" })?.livemode).toBe(false);
  });
});

describe("Stripe plumbing", () => {
  it("form-encodes nested objects and arrays the way Stripe reads them", () => {
    const s = decodeURIComponent(formEncode({ a: 1, b: { c: "x", d: [1, 2] }, e: ["card", "acss_debit"], skip: undefined }));
    expect(s).toBe("a=1&b[c]=x&b[d][0]=1&b[d][1]=2&e[0]=card&e[1]=acss_debit");
  });

  it("accepts a correct webhook signature and refuses a wrong, missing or stale one", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const now = 1_800_000_000;
    expect(verifyStripeSignature(body, signStripePayload(body, "whsec_test", now), "whsec_test", now)).toBe(true);
    expect(verifyStripeSignature(body, signStripePayload(body, "whsec_other", now), "whsec_test", now)).toBe(false);
    expect(verifyStripeSignature(body + " ", signStripePayload(body, "whsec_test", now), "whsec_test", now)).toBe(false);
    expect(verifyStripeSignature(body, undefined, "whsec_test", now)).toBe(false);
    expect(verifyStripeSignature(body, signStripePayload(body, "whsec_test", now - 3600), "whsec_test", now)).toBe(false);
  });
});

describe("creating a link", () => {
  it("checks the amount, description, methods and record", () => {
    const bad = validateCreate({ amount: "0.5", description: "", methods: [], expires_days: 200 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["amount", "description", "expires_days", "methods", "record"]);
    const good = validateCreate({ application_id: APP, amount: "$2,500.00", description: "Broker fee", methods: ["acss_debit"] });
    expect(good).toEqual({ ok: true, value: { applicationId: APP, contactId: null, amountCents: 250000, description: "Broker fee", methods: ["acss_debit"], expiresDays: 30 } });
  });

  it("suggests the signed fee agreement's fee: fixed, else its percent of the requested (or funded) amount", async () => {
    const row = (over: Record<string, unknown>) => ({ query: vi.fn(answerBySql([[/FROM applications a LEFT JOIN media_fee_agreements m/, { rows: [{ requested_amount: "100000", funded_amount: null, funded_at: null, status: "signed", fee_percent: null, fee_amount: null, ...over }] }]])) });
    expect(await suggestedFee(row({}), APP)).toEqual({ amount: 2000, description: "Broker fee (2% of the amount requested)" });
    expect(await suggestedFee(row({ fee_amount: "1500" }), APP)).toEqual({ amount: 1500, description: "Broker fee" });
    expect(await suggestedFee(row({ fee_percent: "3", funded_at: new Date(), funded_amount: "200000" }), APP)).toEqual({ amount: 6000, description: "Broker fee (3% of funding)" });
    expect(await suggestedFee(row({ status: "pending" }), APP)).toBeNull();
  });

  it("writes a readable email and text with the link and no staff number", () => {
    const m = linkMessage(link(), "Pat");
    expect(m.subject).toBe("Payment request from Boreal Financial: $2,500.00");
    expect(m.text).toContain("/api/payments/pay/" + "t".repeat(32));
    expect(m.text).toContain("by card or by pre-authorized debit");
    expect(m.sms).toContain("Reply STOP");
    expect(m.html + m.text + m.sms).not.toMatch(/587.?888.?1837/);
  });

  it("texts only with consent and reports why not", async () => {
    let contact = { first_name: "Pat", email: "pat@x.test", phone: "+14035550100", sms_out: false, sms_ok: false };
    const q = vi.fn(answerBySql([[/FROM contacts c WHERE c.id = \$1::uuid/, () => ({ rows: [contact] })]]));
    const email = vi.fn(async () => ({ ok: true })), sms = vi.fn(async () => ({ ok: true }));
    const r = await sendLink({ query: q }, link(), { email: true, sms: true }, { email, sms }, null);
    expect(r.sent).toEqual(["email"]);
    expect(r.refused.sms).toMatch(/not agreed to texts/);
    expect(sms).not.toHaveBeenCalled();
    expect(callsMatching(q, /INSERT INTO crm_timeline_events/)).toHaveLength(1);
    contact = { ...contact, sms_ok: true, sms_out: true };
    expect((await sendLink({ query: q }, link(), { sms: true }, { email, sms }, null)).refused.sms).toMatch(/STOP/);
    contact = { ...contact, sms_out: false };
    expect((await sendLink({ query: q }, link(), { sms: true }, { email, sms }, null)).sent).toEqual(["sms"]);
  });
});

describe("the client opens the link", () => {
  const db = () => ({ query: vi.fn(answerBySql([])) });

  it("creates a Checkout session on Boreal's own account with card and pre-authorized debit (no Connect header)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    setStripeFetchForTests(async (url, init) => { calls.push({ url, init: init! }); return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1", expires_at: 1_900_000_000 }), { status: 200 }); });
    const d = db();
    const r = await openCheckout(d, CFG, link(), { customerEmail: "pat@x.test" });
    expect(r).toEqual({ kind: "redirect", url: "https://checkout.stripe.com/c/cs_1" });
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Stripe-Account"]).toBeUndefined();
    expect(headers.Authorization).toBe("Bearer sk_test_x");
    expect(headers["Idempotency-Key"]).toBe(`bf-pl-${LINK}-1`);
    const body = decodeURIComponent(String(calls[0]!.init.body));
    expect(body).toContain("payment_method_types[0]=card&payment_method_types[1]=acss_debit");
    expect(body).toContain("payment_method_options[acss_debit][mandate_options][payment_schedule]=sporadic");
    expect(body).toContain("payment_method_options[acss_debit][mandate_options][transaction_type]=business");
    expect(body).toContain("line_items[0][price_data][unit_amount]=250000");
    expect(body).toContain("line_items[0][price_data][currency]=cad");
    expect(body).toContain(`metadata[boreal_payment_link]=${LINK}`);
    expect(callsMatching(d.query, /UPDATE payment_links SET checkout_session_id/)).toHaveLength(1);
  });

  it("reuses a Checkout page that is still open, and explains paid, expired and test-mode links", async () => {
    setStripeFetchForTests(async () => { throw new Error("should not call Stripe"); });
    const open = link({ checkout_url: "https://checkout.stripe.com/c/old", checkout_expires_at: new Date(Date.now() + 3_600_000) });
    expect(await openCheckout(db(), CFG, open)).toEqual({ kind: "redirect", url: "https://checkout.stripe.com/c/old" });
    expect(await openCheckout(db(), CFG, link({ status: "paid" }))).toMatchObject({ kind: "page", title: "Already paid" });
    expect(await openCheckout(db(), CFG, link({ status: "processing" }))).toMatchObject({ kind: "page", title: "Payment in progress" });
    expect(await openCheckout(db(), CFG, link({ expires_at: new Date(Date.now() - 1000) }))).toMatchObject({ kind: "page", status: 410 });
    expect(await openCheckout(db(), CFG, link({ livemode: true }))).toMatchObject({ kind: "page", status: 503 });
  });
});

describe("Stripe events", () => {
  function store(l: LinkRow) {
    const state = { link: { ...l } };
    const q = vi.fn(answerBySql([
      [/FROM payment_links WHERE id = \$1::uuid/, () => ({ rows: [state.link] })],
      [/UPDATE payment_links SET status = 'paid'/, () => { state.link = { ...state.link, status: "paid" }; return { rows: [] }; }],
      [/UPDATE payment_links SET status = 'processing'/, () => { state.link = { ...state.link, status: "processing" }; return { rows: [] }; }],
      [/UPDATE payment_links SET status = 'failed'/, () => { state.link = { ...state.link, status: "failed" }; return { rows: [] }; }],
      [/SELECT owner_user_id::text AS uid FROM applications/, { rows: [{ uid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }] }],
    ]));
    return { q, state };
  }
  const session = (over: Record<string, unknown> = {}) => ({ id: "cs_1", client_reference_id: LINK, metadata: { boreal_payment_link: LINK }, amount_total: 250000, payment_intent: "pi_1", ...over });

  it("a card payment is paid at once, goes on the timeline, tells the file's owner and is recorded in QuickBooks", async () => {
    const { q, state } = store(link());
    const qbo = vi.fn(async () => {});
    const r = await handleStripeEvent({ query: q }, { type: "checkout.session.completed", data: { object: session({ payment_status: "paid" }) } }, { recordInQuickBooks: qbo });
    expect(r).toEqual({ handled: true, linkId: LINK, status: "paid" });
    expect(state.link.status).toBe("paid");
    expect(callsMatching(q, /UPDATE payment_links SET status = 'paid'/)[0]![1]).toEqual([LINK, "pi_1", "card", 250000]);
    const [, tl] = callsMatching(q, /INSERT INTO crm_timeline_events/)[0]!;
    expect((tl as unknown[])[2]).toBe("payment_received");
    expect(callsMatching(q, /INSERT INTO notifications/)).toHaveLength(1);
    expect(qbo).toHaveBeenCalledWith(LINK);
  });

  it("a bank debit is processing, then paid (or failed and open to retry)", async () => {
    const { q, state } = store(link());
    await handleStripeEvent({ query: q }, { type: "checkout.session.completed", data: { object: session({ payment_status: "unpaid" }) } });
    expect(state.link.status).toBe("processing");
    expect((callsMatching(q, /INSERT INTO crm_timeline_events/)[0]![1] as unknown[])[2]).toBe("payment_processing");
    await handleStripeEvent({ query: q }, { type: "checkout.session.async_payment_succeeded", data: { object: session({ payment_status: "paid" }) } });
    expect(state.link.status).toBe("paid");
    expect(callsMatching(q, /UPDATE payment_links SET status = 'paid'/)[0]![1]).toEqual([LINK, "pi_1", "acss_debit", 250000]);
    const failed = store(link());
    await handleStripeEvent({ query: failed.q }, { type: "checkout.session.async_payment_failed", data: { object: session() } });
    expect(failed.state.link.status).toBe("failed");
    expect((callsMatching(failed.q, /INSERT INTO crm_timeline_events/)[0]![1] as unknown[])[2]).toBe("payment_failed");
  });

  it("ignores a Checkout session that is not a Boreal payment link", async () => {
    const q = vi.fn(answerBySql([]));
    const r = await handleStripeEvent({ query: q }, { type: "checkout.session.completed", data: { object: { id: "cs_other", payment_status: "paid" } } });
    expect(r.handled).toBe(false);
    expect(callsMatching(q, /UPDATE payment_links/)).toHaveLength(0);
  });

  it("shows an open link past its date as expired", () => {
    expect(linkView(link({ expires_at: new Date(Date.now() - 1) })).status).toBe("expired");
    expect(linkView(link()).url).toContain("/api/payments/pay/");
  });
});

describe("QuickBooks", () => {
  const ENV = { QBO_CLIENT_ID: "id", QBO_CLIENT_SECRET: "secret", QBO_TOKEN_ENCRYPTION_KEY: "k".repeat(40) };

  it("a paid link pays the file's fee invoice and marks it paid when nothing is left owing", async () => {
    let paid = link({ status: "paid", amount_received_cents: 250000, payment_intent_id: "pi_1", quickbooks_status: "pending" });
    const q = vi.fn(answerBySql([
      [/FROM payment_links WHERE id = \$1::uuid/, () => ({ rows: [paid] })],
      [/FROM qbo_fee_invoices WHERE application_id/, { rows: [{ qbo_invoice_id: "INV-9", qbo_customer_id: "CUS-1", status: "open" }] }],
      [/UPDATE payment_links SET quickbooks_status/, (_s: string, p?: unknown[]) => { paid = { ...paid, quickbooks_status: String(p![1]) }; return { rows: [] }; }],
    ]));
    qbo.getConnection.mockResolvedValue({ realm_id: "R1" });
    qbo.qboRequest.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path === "invoice/INV-9") return { Invoice: { Id: "INV-9", Balance: 2500, CustomerRef: { value: "CUS-1" } } };
      if (method === "POST" && path === "payment") return { Payment: { Id: "PAY-1" } };
      throw new Error(`unexpected ${method} ${path}`);
    });
    expect(await recordInQuickBooks({ query: q }, LINK, { env: ENV })).toBe("recorded");
    const pay = qbo.qboRequest.mock.calls.find(([m, p]) => m === "POST" && p === "payment")!;
    expect(pay[2]).toMatchObject({ TotalAmt: 2500, CustomerRef: { value: "CUS-1" }, Line: [{ Amount: 2500, LinkedTxn: [{ TxnId: "INV-9", TxnType: "Invoice" }] }] });
    expect(pay[4]).toEqual({ requestid: `bf-stripe-${LINK}`.slice(0, 50) });
    expect(callsMatching(q, /UPDATE qbo_fee_invoices SET status = 'paid'/)).toHaveLength(1);
    expect(paid.quickbooks_status).toBe("recorded");
  });

  it("a part payment is recorded but the invoice stays open", async () => {
    const q = vi.fn(answerBySql([
      [/FROM payment_links WHERE id = \$1::uuid/, { rows: [link({ status: "paid", amount_received_cents: 100000, quickbooks_status: "pending" })] }],
      [/FROM qbo_fee_invoices WHERE application_id/, { rows: [{ qbo_invoice_id: "INV-9", qbo_customer_id: "CUS-1", status: "open" }] }],
    ]));
    qbo.getConnection.mockResolvedValue({ realm_id: "R1" });
    qbo.qboRequest.mockImplementation(async (method: string) => (method === "GET" ? { Invoice: { Balance: 2500 } } : { Payment: { Id: "PAY-2" } }));
    expect(await recordInQuickBooks({ query: q }, LINK, { env: ENV })).toBe("recorded");
    expect(callsMatching(q, /UPDATE qbo_fee_invoices SET status = 'paid'/)).toHaveLength(0);
  });

  it("no fee invoice on the file, or QuickBooks not set up: nothing to record", async () => {
    qbo.qboRequest.mockReset();
    const q = vi.fn(answerBySql([
      [/FROM payment_links WHERE id = \$1::uuid/, { rows: [link({ status: "paid", quickbooks_status: "pending" })] }],
      [/FROM qbo_fee_invoices WHERE application_id/, { rows: [] }],
    ]));
    expect(await recordInQuickBooks({ query: q }, LINK, { env: {} })).toBe("not_applicable");
    expect(await recordInQuickBooks({ query: q }, LINK, { env: ENV })).toBe("not_applicable");
    expect(qbo.qboRequest).not.toHaveBeenCalled();
  });

  it("a QuickBooks failure is retried later, then given up", async () => {
    const q = vi.fn(answerBySql([
      [/FROM payment_links WHERE id = \$1::uuid/, { rows: [link({ status: "paid", quickbooks_status: "pending", quickbooks_attempts: 0 })] }],
      [/FROM qbo_fee_invoices WHERE application_id/, { rows: [{ qbo_invoice_id: "INV-9" }] }],
    ]));
    qbo.getConnection.mockResolvedValue({ realm_id: "R1" });
    qbo.qboRequest.mockRejectedValue(new Error("QuickBooks GET invoice failed (500)"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await recordInQuickBooks({ query: q }, LINK, { env: ENV })).toBe("retrying");
    err.mockRestore();
  });
});
