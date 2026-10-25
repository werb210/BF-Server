// BF_SERVER_v852_CALC_QBO - QuickBooks invoices for the client-side media fee agreement ("2% on funding").
//
//   SIGNED  (media_fee_agreements.status = 'signed', by SignNow or marked signed by staff)
//           -> find or create the QuickBooks customer (company name, else email), then one invoice with one line,
//              "Media funding fee (2% of funding)", at the agreement's percent x the amount known at signing (the
//              requested amount). A fixed fee agreed by staff is invoiced as that fixed amount.
//   FUNDED  (applications.funded_at set, or the file is Accepted / Funded)
//           -> the invoice is changed to the funded amount when that differs, and a QuickBooks Payment for the
//              balance marks it paid.
//
// qbo_fee_invoices holds one row per application (application_id, qbo_invoice_id, doc_number, amount, status
// pending/open/paid, synced_at) and doubles as the outbox: sync_state queued/ok/failed, attempts, next_attempt_at
// (exponential backoff, at most MAX_ATTEMPTS automatic tries; Retry in the portal starts again). Every failure is
// logged. Creating the invoice and the payment send an Intuit requestid derived from the application, so a retry
// after a lost answer cannot create a second invoice or payment. Off entirely when QuickBooks is not configured.
import { pool } from "../../db.js";
import { qboConfigured, qboInvoiceUrl } from "./qboConfig.js";
import { QboError, getConnection, qboQueryEntities, qboQuote, qboRequest, type QboDeps, type Q } from "./qboClient.js";

export const DEFAULT_FEE_PERCENT = 2;
export const MAX_ATTEMPTS = 8;
export const FEE_ITEM_NAME = "Media funding fee";
export const TAX_CODE_SETTING = "quickbooks.tax_code";
export const ITEM_SETTING = "quickbooks.fee_item";
const LEASE_SECONDS = 120;

const dbOf = (d?: QboDeps): Q => d?.db ?? (pool as unknown as Q);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export type FeeTerms = { percent: number | null; fixed: number | null };

/** The fee for a basis amount: a fixed fee as agreed, otherwise percent (default 2) x basis, in cents. */
export function feeAmountFor(terms: FeeTerms, basis: number | null): number | null {
  if (terms.fixed !== null && terms.fixed >= 0) return round2(terms.fixed);
  if (basis === null || !(basis > 0)) return null;
  const pct = terms.percent !== null && terms.percent >= 0 ? terms.percent : DEFAULT_FEE_PERCENT;
  return round2((basis * pct) / 100);
}

export function feeLineDescription(terms: FeeTerms): string {
  if (terms.fixed !== null && terms.fixed >= 0) return "Media funding fee (fixed fee)";
  const pct = terms.percent !== null && terms.percent >= 0 ? terms.percent : DEFAULT_FEE_PERCENT;
  return "Media funding fee (" + String(Number(pct.toFixed(3))) + "% of funding)";
}

/** Retry delay after the given number of failed attempts: 1, 2, 4 ... minutes, at most 6 hours (the SQL in syncFeeInvoice). */
export function backoffMs(attempts: number): number {
  return Math.min(6 * 60, 2 ** Math.max(0, attempts - 1)) * 60 * 1000;
}

export function isFundedApp(app: { funded_at?: unknown; pipeline_state?: unknown }): boolean {
  return Boolean(app.funded_at) || /^(accepted|funded)$/i.test(String(app.pipeline_state ?? "").trim());
}

/**
 * Put an application on the QuickBooks queue (signing and funding call this). No-op when QuickBooks is not
 * configured. A paid invoice is left alone. Then tries it straight away in the background; the worker is the backstop.
 */
export async function enqueueFeeInvoiceSync(applicationId: string, reason: string, deps?: QboDeps): Promise<void> {
  if (!qboConfigured(deps?.env) || !applicationId) return;
  try {
    await dbOf(deps).query(
      `INSERT INTO qbo_fee_invoices (application_id, sync_state, next_attempt_at, attempts, created_at, updated_at)
       VALUES ($1, 'queued', now(), 0, now(), now())
       ON CONFLICT (application_id) DO UPDATE SET sync_state = 'queued', next_attempt_at = now(), attempts = 0, updated_at = now()
        WHERE qbo_fee_invoices.status <> 'paid'`,
      [applicationId],
    );
  } catch (err) {
    console.error("[quickbooks] enqueue failed", { applicationId, reason, message: (err as Error)?.message });
    return;
  }
  if (deps?.db) return; // tests drive the sync themselves
  setImmediate(() => {
    void syncFeeInvoice(applicationId).catch((err) => console.error("[quickbooks] immediate sync failed", { applicationId, reason, message: (err as Error)?.message }));
  });
}

type AgreementRow = { status: string; fee_percent: unknown; fee_amount: unknown; signer_name: string | null; signer_email: string | null };
type AppRow = { id: string; name: string | null; requested_amount: unknown; funded_amount: unknown; funded_at: unknown; pipeline_state: string | null; metadata: any };
export type InvoiceRow = {
  application_id: string; qbo_invoice_id: string | null; doc_number: string | null; qbo_customer_id: string | null; amount: unknown;
  status: string; qbo_payment_id: string | null; sync_state: string; attempts: number; last_error: string | null; synced_at: unknown;
};

function companyAndEmail(app: AppRow, agreement: AgreementRow): { company: string | null; email: string | null; person: string | null } {
  const md = app.metadata && typeof app.metadata === "object" ? app.metadata : {};
  const business = md.business && typeof md.business === "object" ? md.business : {};
  const applicant = md.applicant && typeof md.applicant === "object" ? md.applicant : {};
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    company: s(business.legalName) ?? s(business.companyName) ?? s(business.businessName) ?? s(app.name),
    email: s(agreement.signer_email) ?? s(applicant.email),
    person: s(agreement.signer_name),
  };
}

async function settingValue(key: string, deps?: QboDeps): Promise<string | null> {
  const r = await dbOf(deps).query(`SELECT value FROM settings WHERE key = $1 LIMIT 1`, [key]);
  const v = r.rows[0]?.value;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function saveSetting(key: string, value: string, deps?: QboDeps): Promise<void> {
  await dbOf(deps).query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

export async function getTaxCode(deps?: QboDeps): Promise<string | null> {
  return settingValue(TAX_CODE_SETTING, deps);
}

export async function setTaxCode(code: string | null, deps?: QboDeps): Promise<void> {
  if (code) await saveSetting(TAX_CODE_SETTING, code, deps);
  else await dbOf(deps).query(`DELETE FROM settings WHERE key = $1`, [TAX_CODE_SETTING]);
}

/** The QuickBooks customer for this file: matched by company name, then email; created when neither matches. */
export async function findOrCreateCustomer(company: string | null, email: string | null, person: string | null, applicationId: string, deps?: QboDeps): Promise<string> {
  if (company) {
    const byName = await qboQueryEntities("Customer", "DisplayName = " + qboQuote(company), deps);
    if (byName[0]?.Id) return String(byName[0].Id);
  }
  if (email) {
    const byEmail = await qboQueryEntities("Customer", "PrimaryEmailAddr = " + qboQuote(email), deps);
    if (byEmail[0]?.Id) return String(byEmail[0].Id);
  }
  const display = (company ?? person ?? email ?? "Boreal client " + applicationId.slice(-6)).slice(0, 100);
  const body: Record<string, unknown> = { DisplayName: display, ...(company ? { CompanyName: company.slice(0, 100) } : {}), ...(email ? { PrimaryEmailAddr: { Address: email } } : {}) };
  try {
    const out = await qboRequest("POST", "customer", body, deps);
    return String(out.Customer.Id);
  } catch (err) {
    // DisplayName must be unique across customers, vendors and employees: a vendor with the same name blocks it.
    if (!(err instanceof QboError) || !/duplicate/i.test(err.message)) throw err;
    const out = await qboRequest("POST", "customer", { ...body, DisplayName: (display.slice(0, 85) + " (Boreal " + applicationId.slice(-6) + ")") }, deps);
    return String(out.Customer.Id);
  }
}

/** The service item the fee line uses ("Media funding fee"), created once against the first income account. */
export async function feeItemId(realmId: string, deps?: QboDeps): Promise<string> {
  const cached = await settingValue(ITEM_SETTING, deps);
  if (cached && cached.startsWith(realmId + ":")) return cached.slice(realmId.length + 1);
  const found = await qboQueryEntities("Item", "Name = " + qboQuote(FEE_ITEM_NAME), deps);
  let id = found[0]?.Id ? String(found[0].Id) : null;
  if (!id) {
    const accounts = await qboQueryEntities("Account", "AccountType = 'Income'", deps);
    if (!accounts[0]?.Id) throw new QboError("QuickBooks has no income account for the fee item", 0, "no_income_account");
    const out = await qboRequest("POST", "item", { Name: FEE_ITEM_NAME, Type: "Service", IncomeAccountRef: { value: String(accounts[0].Id) } }, deps);
    id = String(out.Item.Id);
  }
  await saveSetting(ITEM_SETTING, realmId + ":" + id, deps);
  return id;
}

function feeLine(amount: number, description: string, itemId: string, taxCode: string | null): Record<string, unknown> {
  return {
    DetailType: "SalesItemLineDetail",
    Amount: amount,
    Description: description,
    SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: amount, ...(taxCode ? { TaxCodeRef: { value: taxCode } } : {}) },
  };
}

async function loadInputs(applicationId: string, deps?: QboDeps): Promise<{ agreement: AgreementRow | null; app: AppRow | null; row: InvoiceRow | null }> {
  const db = dbOf(deps);
  const [a, b, c] = await Promise.all([
    db.query(`SELECT status, fee_percent, fee_amount, signer_name, signer_email FROM media_fee_agreements WHERE application_id = $1 LIMIT 1`, [applicationId]),
    db.query(`SELECT id::text AS id, name, requested_amount, funded_amount, funded_at, pipeline_state, metadata FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId]),
    db.query(`SELECT application_id, qbo_invoice_id, doc_number, qbo_customer_id, amount, status, qbo_payment_id, sync_state, attempts, last_error, synced_at FROM qbo_fee_invoices WHERE application_id = $1 LIMIT 1`, [applicationId]),
  ]);
  return { agreement: (a.rows[0] as AgreementRow) ?? null, app: (b.rows[0] as AppRow) ?? null, row: (c.rows[0] as InvoiceRow) ?? null };
}

export type SyncOutcome = { ok: boolean; action: string; error?: string };

/** Bring QuickBooks in line with the file. Safe to run any number of times. */
export async function syncFeeInvoice(applicationId: string, deps?: QboDeps): Promise<SyncOutcome> {
  if (!qboConfigured(deps?.env)) return { ok: false, action: "not_configured" };
  const db = dbOf(deps);
  // A short lease so the worker, a Retry and a signing hook never work on the same file at once.
  const lease = await db.query(
    `INSERT INTO qbo_fee_invoices (application_id, sync_state, lease_until, created_at, updated_at)
     VALUES ($1, 'queued', now() + make_interval(secs => $2::int), now(), now())
     ON CONFLICT (application_id) DO UPDATE SET lease_until = EXCLUDED.lease_until
      WHERE qbo_fee_invoices.lease_until IS NULL OR qbo_fee_invoices.lease_until < now()
     RETURNING application_id`,
    [applicationId, LEASE_SECONDS],
  );
  if (!lease.rows[0]) return { ok: false, action: "busy" };
  try {
    const outcome = await reconcile(applicationId, deps);
    await db.query(
      `UPDATE qbo_fee_invoices SET sync_state = 'ok', attempts = 0, last_error = NULL, lease_until = NULL, updated_at = now() WHERE application_id = $1`,
      [applicationId],
    );
    return outcome;
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    console.error({ event: "qbo_fee_invoice_sync_failed", applicationId, message, code: err instanceof QboError ? err.code : null });
    await db.query(
      `UPDATE qbo_fee_invoices SET sync_state = 'failed', attempts = attempts + 1, last_error = $2, last_attempt_at = now(), lease_until = NULL,
              next_attempt_at = now() + make_interval(mins => LEAST(360, power(2, LEAST(attempts, 9))::int)), updated_at = now()
        WHERE application_id = $1`,
      [applicationId, message],
    ).catch((e: unknown) => console.error("[quickbooks] could not record the failure", { applicationId, message: (e as Error)?.message }));
    return { ok: false, action: "failed", error: message };
  }
}

async function reconcile(applicationId: string, deps?: QboDeps): Promise<SyncOutcome> {
  const db = dbOf(deps);
  const { agreement, app, row } = await loadInputs(applicationId, deps);
  if (!app) return { ok: true, action: "application_not_found" };
  if (row?.status === "paid") return { ok: true, action: "already_paid" };
  if (!row?.qbo_invoice_id && agreement?.status !== "signed") return { ok: true, action: "agreement_not_signed" };
  const conn = await getConnection(deps);
  if (!conn) throw new QboError("QuickBooks is not connected", 0, "not_connected");

  const terms: FeeTerms = { percent: num(agreement?.fee_percent), fixed: num(agreement?.fee_amount) };
  const description = feeLineDescription(terms);
  const taxCode = await getTaxCode(deps);
  let invoiceId = row?.qbo_invoice_id ?? null;
  let customerId = row?.qbo_customer_id ?? null;
  let amount = num(row?.amount);
  let action = "unchanged";

  if (!invoiceId) {
    const signedAmount = feeAmountFor(terms, num(app.requested_amount));
    if (signedAmount === null) throw new QboError("The application has no requested amount to invoice the fee on", 0, "no_amount");
    const who = companyAndEmail(app, agreement as AgreementRow);
    customerId = await findOrCreateCustomer(who.company, who.email, who.person, applicationId, deps);
    const itemId = await feeItemId(conn.realm_id, deps);
    const created = await qboRequest("POST", "invoice", {
      CustomerRef: { value: customerId },
      Line: [feeLine(signedAmount, description, itemId, taxCode)],
      ...(taxCode ? { GlobalTaxCalculation: "TaxExcluded" } : {}),
      ...(who.email ? { BillEmail: { Address: who.email } } : {}),
      PrivateNote: "Boreal Financial application " + applicationId + " - media fee agreement",
    }, deps, { requestid: ("bf-fee-inv-" + applicationId).slice(0, 50) });
    invoiceId = String(created.Invoice.Id);
    amount = signedAmount;
    await db.query(
      `UPDATE qbo_fee_invoices SET qbo_invoice_id = $2, doc_number = $3, qbo_customer_id = $4, amount = $5, status = 'open', synced_at = now(), updated_at = now()
        WHERE application_id = $1`,
      [applicationId, invoiceId, created.Invoice.DocNumber ?? null, customerId, signedAmount],
    );
    console.info({ event: "qbo_fee_invoice_created", applicationId, invoiceId, amount: signedAmount });
    action = "invoice_created";
  }

  if (!isFundedApp(app)) return { ok: true, action };

  // Funded: the invoice follows the funded amount, then a payment marks it paid.
  const fundedAmount = feeAmountFor(terms, num(app.funded_amount) ?? num(app.requested_amount));
  let invoice = (await qboRequest("GET", "invoice/" + encodeURIComponent(invoiceId), undefined, deps)).Invoice;
  if (fundedAmount !== null && amount !== fundedAmount) {
    const itemId = invoice?.Line?.find((l: any) => l?.SalesItemLineDetail?.ItemRef?.value)?.SalesItemLineDetail?.ItemRef?.value ?? (await feeItemId(conn.realm_id, deps));
    invoice = (await qboRequest("POST", "invoice", { Id: invoiceId, SyncToken: invoice.SyncToken, sparse: true, Line: [feeLine(fundedAmount, description, String(itemId), taxCode)] }, deps)).Invoice;
    amount = fundedAmount;
    await db.query(`UPDATE qbo_fee_invoices SET amount = $2, synced_at = now(), updated_at = now() WHERE application_id = $1`, [applicationId, fundedAmount]);
    console.info({ event: "qbo_fee_invoice_updated", applicationId, invoiceId, amount: fundedAmount });
  }
  const balance = num(invoice?.Balance) ?? num(invoice?.TotalAmt) ?? amount ?? 0;
  let paymentId: string | null = null;
  if (balance > 0) {
    const paid = await qboRequest("POST", "payment", {
      CustomerRef: { value: String(invoice?.CustomerRef?.value ?? customerId) },
      TotalAmt: balance,
      Line: [{ Amount: balance, LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }] }],
      PrivateNote: "Boreal Financial: fee paid from the loan proceeds at funding (application " + applicationId + ")",
    }, deps, { requestid: ("bf-fee-pay-" + applicationId).slice(0, 50) });
    paymentId = String(paid.Payment.Id);
  }
  await db.query(
    `UPDATE qbo_fee_invoices SET status = 'paid', qbo_payment_id = COALESCE($2, qbo_payment_id), synced_at = now(), updated_at = now() WHERE application_id = $1`,
    [applicationId, paymentId],
  );
  console.info({ event: "qbo_fee_invoice_paid", applicationId, invoiceId, paymentId, amount });
  return { ok: true, action: "paid" };
}

/** Worker step 1: queue signed agreements and funded files that QuickBooks has not caught up with. */
export async function discoverWork(deps?: QboDeps): Promise<number> {
  const db = dbOf(deps);
  // Only agreements signed since QuickBooks was first connected: older fees were invoiced by hand.
  const signed = await db.query(
    `INSERT INTO qbo_fee_invoices (application_id, sync_state, next_attempt_at, created_at, updated_at)
     SELECT m.application_id, 'queued', now(), now(), now()
       FROM media_fee_agreements m
       JOIN qbo_connections c ON c.id = 'company'
      WHERE m.status = 'signed' AND m.signed_at IS NOT NULL AND m.signed_at >= COALESCE(c.first_connected_at, c.connected_at)
        AND NOT EXISTS (SELECT 1 FROM qbo_fee_invoices q WHERE q.application_id = m.application_id)
      LIMIT 50
     ON CONFLICT (application_id) DO NOTHING
     RETURNING application_id`,
    [],
  );
  const funded = await db.query(
    `UPDATE qbo_fee_invoices q SET sync_state = 'queued', next_attempt_at = now(), updated_at = now()
       FROM applications a
      WHERE a.id::text = q.application_id AND q.status = 'open' AND q.sync_state = 'ok'
        AND (a.funded_at IS NOT NULL OR lower(COALESCE(a.pipeline_state, '')) IN ('accepted', 'funded'))
     RETURNING q.application_id`,
    [],
  );
  return (signed.rows?.length ?? 0) + (funded.rows?.length ?? 0);
}

/** One worker tick: discover, then sync what is due (a few at a time). */
export async function runFeeInvoiceTick(deps?: QboDeps, batch = 10): Promise<{ queued: number; synced: number; failed: number }> {
  const out = { queued: 0, synced: 0, failed: 0 };
  if (!qboConfigured(deps?.env)) return out;
  if (!(await getConnection(deps))) return out;
  out.queued = await discoverWork(deps);
  const due = await dbOf(deps).query(
    `SELECT application_id FROM qbo_fee_invoices
      WHERE sync_state IN ('queued', 'failed') AND attempts < $1 AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC LIMIT $2`,
    [MAX_ATTEMPTS, batch],
  );
  for (const r of due.rows) {
    const res = await syncFeeInvoice(String(r.application_id), deps);
    if (res.ok) out.synced++;
    else if (res.action === "failed") out.failed++;
  }
  return out;
}

export type InvoiceView = {
  qboInvoiceId: string | null; docNumber: string | null; amount: number | null; status: "pending" | "open" | "paid";
  syncState: string; lastError: string | null; attempts: number; syncedAt: string | null; url: string | null;
};

export function invoiceView(row: InvoiceRow | null, env?: Record<string, string | undefined>): InvoiceView | null {
  if (!row) return null;
  const status = row.status === "paid" ? "paid" : row.status === "open" ? "open" : "pending";
  return {
    qboInvoiceId: row.qbo_invoice_id, docNumber: row.doc_number, amount: num(row.amount), status,
    syncState: row.sync_state, lastError: row.last_error, attempts: Number(row.attempts ?? 0),
    syncedAt: row.synced_at ? new Date(row.synced_at as string).toISOString() : null,
    url: row.qbo_invoice_id ? qboInvoiceUrl(row.qbo_invoice_id, env) : null,
  };
}

export async function getInvoiceRow(applicationId: string, deps?: QboDeps): Promise<InvoiceRow | null> {
  const r = await dbOf(deps).query(
    `SELECT application_id, qbo_invoice_id, doc_number, qbo_customer_id, amount, status, qbo_payment_id, sync_state, attempts, last_error, synced_at
       FROM qbo_fee_invoices WHERE application_id = $1 LIMIT 1`,
    [applicationId],
  );
  return (r.rows[0] as InvoiceRow) ?? null;
}
