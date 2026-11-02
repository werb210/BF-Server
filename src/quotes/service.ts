// BF_SERVER_v872_QUOTES - quotes (ported from KS-server #50 without the plan gate): staff build an offer summary for
// the client from the lender offers on a file, send it as a branded PDF and a client-app page, and track when it is
// viewed, accepted or declined.
//
//   draft      staff edit freely; the client cannot see it.
//   sent       the client gets a "View your quote" button in the client app and a push or text; a PDF copy is stored
//              on the application's Documents (category "Quote").
//   viewed     the client opened it (first and last view, and how many times).
//   accepted   the client picked one option, typed their name and ticked the box. When that option came from an offer
//              on the file, the offer is staged for acceptance exactly as the offer's own Accept button does, so staff
//              "Confirm acceptance" and the lender e-signing that follows are unchanged.
//   declined / withdrawn / expired   (expired = the expiry day passed before the client answered; worked out on read).
//
// Sales tax: each fee has a "taxable" tick; the quote's province (the business's province by default, staff can
// change it) picks the rate from the v865 sales-tax table (Settings > Deal tools), as of the day the quote is saved.
import { createHash, randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { brandName, clientUrl } from "../settingsPack/boreal.js";
import { getStorage, type StorageBackend } from "../lib/storage/index.js";
import type { Q } from "../settingsPack/common.js";
import { applicationProvince, feeTaxFor, normaliseProvince, rateOn, type Province, type TaxLine } from "../brokerTools/salesTax.js";
import { FREQUENCIES, NO_FEE_TAX, computeOption, parseFrequency, parseRate, parseTermMonths, type Fee, type FeeTax, type Frequency } from "./calc.js";

export type Db = Q;
const defaultDb = (): Db => pool as unknown as Db;

export const QUOTE_STATUSES = ["draft", "sent", "viewed", "accepted", "declined", "expired", "withdrawn"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
const ANSWERABLE: ReadonlySet<string> = new Set(["sent", "viewed"]);
export const LIMITS = { options: 6, fees: 8, title: 120, message: 2000, notes: 500, label: 80 };

export type OptionRow = {
  id: string; position: number; offer_id: string | null; lender_name: string; product_name: string | null; amount: number;
  term_months: number | null; rate_kind: "interest_rate" | "factor_rate"; rate: number | null; payment_frequency: Frequency;
  payment_count: number | null; payment_amount: number | null; payment_overridden: boolean; fees: Fee[]; tax_lines: TaxLine[];
  total_tax: number; total_fees: number; total_repayment: number | null; cost_of_borrowing: number | null; net_proceeds: number | null;
  estimated_apr: number | null; recommended: boolean; notes: string | null;
};

export type QuoteView = {
  id: string; application_id: string; quote_number: string; status: QuoteStatus; title: string; message: string | null; currency: "CAD" | "USD";
  tax_province: Province | null; expires_on: string | null; pdf_document_id: string | null; accepted_option_id: string | null; accepted_name: string | null;
  decline_reason: string | null; view_count: number; created_at: string; sent_at: string | null; first_viewed_at: string | null;
  last_viewed_at: string | null; accepted_at: string | null; declined_at: string | null; withdrawn_at: string | null; options: OptionRow[];
};

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const day = (v: unknown): string | null => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return []; } })() : []);

function optionOf(r: any): OptionRow {
  return {
    id: String(r.id), position: Number(r.position) || 0, offer_id: r.offer_id ?? null, lender_name: String(r.lender_name), product_name: r.product_name ?? null,
    amount: Number(r.amount) || 0, term_months: num(r.term_months), rate_kind: r.rate_kind === "factor_rate" ? "factor_rate" : "interest_rate", rate: num(r.rate),
    payment_frequency: (FREQUENCIES as readonly string[]).includes(r.payment_frequency) ? r.payment_frequency : "monthly",
    payment_count: num(r.payment_count), payment_amount: num(r.payment_amount), payment_overridden: r.payment_overridden === true,
    fees: arr(r.fees).map((f: any) => ({ label: String(f.label ?? ""), amount: Number(f.amount) || 0, deducted: f.deducted === true, taxable: f.taxable === true })),
    tax_lines: arr(r.tax_lines).map((t: any) => ({ label: String(t.label ?? ""), amount: Number(t.amount) || 0 })),
    total_tax: Number(r.total_tax) || 0, total_fees: Number(r.total_fees) || 0, total_repayment: num(r.total_repayment),
    cost_of_borrowing: num(r.cost_of_borrowing), net_proceeds: num(r.net_proceeds), estimated_apr: num(r.estimated_apr),
    recommended: r.recommended === true, notes: r.notes ?? null,
  };
}

/** Sent or viewed past its expiry day reads as expired (and is stored as expired the first time it is read). */
export function effectiveStatus(status: string, expiresOn: string | null, today: string): QuoteStatus {
  if (ANSWERABLE.has(status) && expiresOn && expiresOn < today) return "expired";
  return (QUOTE_STATUSES as readonly string[]).includes(status) ? (status as QuoteStatus) : "draft";
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function loadQuote(db: Db, id: string, now: Date = new Date()): Promise<QuoteView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const q = (await db.query(`SELECT * FROM quotes WHERE id::text = $1 LIMIT 1`, [id])).rows[0];
  if (!q) return null;
  const opts = (await db.query(`SELECT * FROM quote_options WHERE quote_id::text = $1 ORDER BY position, created_at`, [id])).rows.map(optionOf);
  const status = effectiveStatus(q.status, day(q.expires_on), todayIso(now));
  if (status === "expired" && q.status !== "expired") {
    await db.query(`UPDATE quotes SET status = 'expired', updated_at = now() WHERE id::text = $1 AND status IN ('sent', 'viewed')`, [id]);
    await event(db, id, "expired", "system", null, {});
  }
  return {
    id: String(q.id), application_id: String(q.application_id), quote_number: String(q.quote_number), status, title: String(q.title), message: q.message ?? null,
    currency: q.currency === "USD" ? "USD" : "CAD", tax_province: normaliseProvince(q.tax_province), expires_on: day(q.expires_on),
    pdf_document_id: q.pdf_document_id ?? null, accepted_option_id: q.accepted_option_id ? String(q.accepted_option_id) : null,
    accepted_name: q.accepted_name ?? null, decline_reason: q.decline_reason ?? null, view_count: Number(q.view_count) || 0,
    created_at: iso(q.created_at)!, sent_at: iso(q.sent_at), first_viewed_at: iso(q.first_viewed_at), last_viewed_at: iso(q.last_viewed_at),
    accepted_at: iso(q.accepted_at), declined_at: iso(q.declined_at), withdrawn_at: iso(q.withdrawn_at), options: opts,
  };
}

export async function listQuotes(db: Db, applicationId: string, opts: { includeDrafts: boolean } = { includeDrafts: true }): Promise<QuoteView[]> {
  const r = await db.query(
    `SELECT id::text AS id FROM quotes WHERE application_id = $1 AND ($2::boolean OR status <> 'draft') ORDER BY created_at DESC LIMIT 50`,
    [applicationId, opts.includeDrafts],
  );
  const out: QuoteView[] = [];
  for (const row of r.rows) {
    const q = await loadQuote(db, String(row.id));
    if (q) out.push(q);
  }
  return out;
}

async function event(db: Db, quoteId: string, kind: string, actor: "staff" | "client" | "system", userId: string | null, detail: Record<string, unknown>): Promise<void> {
  try {
    await db.query(`INSERT INTO quote_events (quote_id, kind, actor, user_id, detail) VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`, [quoteId, kind, actor, userId, JSON.stringify(detail)]);
  } catch (err) {
    console.warn("[quotes] event not recorded", { quoteId, kind, message: (err as Error)?.message });
  }
}

export async function quoteEvents(db: Db, quoteId: string) {
  const r = await db.query(`SELECT kind, actor, created_at, detail FROM quote_events WHERE quote_id::text = $1 ORDER BY created_at, id`, [quoteId]);
  return r.rows.map((e: any) => ({ kind: e.kind, actor: e.actor, at: iso(e.created_at), detail: e.detail ?? {} }));
}

// ------------------------------------------------------------------------------------------------ input
export type OptionPatch = {
  offer_id?: string | null; lender_name: string; product_name?: string | null; amount: number; term_months: number | null;
  rate_kind: "interest_rate" | "factor_rate"; rate: number | null; payment_frequency: Frequency; payment_count?: number | null;
  payment_amount?: number | null; payment_overridden?: boolean; fees: Fee[]; recommended?: boolean; notes?: string | null;
};

const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);

export function parseOptions(raw: unknown): { ok: true; options: OptionPatch[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "options must be a list" };
  if (raw.length > LIMITS.options) return { ok: false, error: `at most ${LIMITS.options} options` };
  const out: OptionPatch[] = [];
  for (const [i, o] of raw.entries()) {
    const x = (o ?? {}) as Record<string, unknown>;
    const lender = clip(x.lender_name, LIMITS.label);
    const amount = Number(x.amount);
    if (!lender) return { ok: false, error: `Option ${i + 1}: the lender is required.` };
    if (!(amount > 0) || amount > 1e11) return { ok: false, error: `Option ${i + 1}: the amount must be more than 0.` };
    const kind = x.rate_kind === "factor_rate" ? "factor_rate" : "interest_rate";
    const rate = num(x.rate);
    if (rate !== null && (rate < 0 || (kind === "factor_rate" && (rate < 1 || rate > 5)) || (kind === "interest_rate" && rate > 400))) {
      return { ok: false, error: `Option ${i + 1}: ${kind === "factor_rate" ? "a factor rate is between 1 and 5." : "the interest rate looks wrong."}` };
    }
    const term = num(x.term_months);
    if (term !== null && (term <= 0 || term > 600)) return { ok: false, error: `Option ${i + 1}: the term must be between 0 and 600 months.` };
    const freq = (FREQUENCIES as readonly string[]).includes(String(x.payment_frequency)) ? (x.payment_frequency as Frequency) : "monthly";
    const fees = Array.isArray(x.fees) ? x.fees.slice(0, LIMITS.fees) : [];
    const feeList: Fee[] = [];
    for (const f of fees) {
      const label = clip((f as any)?.label, LIMITS.label);
      const amt = Number((f as any)?.amount);
      if (!label && !(amt > 0)) continue;
      if (!label || !(amt >= 0)) return { ok: false, error: `Option ${i + 1}: each fee needs a name and an amount.` };
      feeList.push({ label, amount: Math.round(amt * 100) / 100, deducted: (f as any)?.deducted === true, taxable: (f as any)?.taxable === true });
    }
    const pay = num(x.payment_amount);
    out.push({
      offer_id: x.offer_id ? clip(x.offer_id, 64) : null, lender_name: lender, product_name: clip(x.product_name, LIMITS.label) || null, amount,
      term_months: term, rate_kind: kind, rate, payment_frequency: freq, payment_count: num(x.payment_count),
      payment_amount: pay, payment_overridden: x.payment_overridden === true && pay !== null && pay > 0, fees: feeList,
      recommended: x.recommended === true, notes: clip(x.notes, LIMITS.notes) || null,
    });
  }
  return { ok: true, options: out };
}

/** A starting option from a lender offer on the file (staff then adjust it). */
export function optionFromOffer(o: Record<string, any>): OptionPatch {
  const rate = parseRate(o.rate_factor);
  return {
    offer_id: String(o.id), lender_name: String(o.lender_name ?? "Lender"), product_name: null, amount: Number(o.amount) || 0,
    term_months: parseTermMonths(o.term), rate_kind: rate?.rate_kind ?? "interest_rate", rate: rate?.rate ?? null,
    payment_frequency: parseFrequency(o.payment_frequency), fees: [], recommended: o.recommended === true, notes: null,
  };
}

/** The tax hook for a quote: the province's rate today (from the sales-tax table), or no tax without a province. */
export async function feeTaxForProvince(db: Db, province: Province | null): Promise<FeeTax> {
  if (!province) return NO_FEE_TAX;
  return feeTaxFor(await rateOn(db, province));
}

async function writeOptions(db: Db, quoteId: string, options: OptionPatch[], province: Province | null): Promise<void> {
  const tax = await feeTaxForProvince(db, province);
  await db.query(`DELETE FROM quote_options WHERE quote_id::text = $1`, [quoteId]);
  for (const [i, o] of options.entries()) {
    const m = computeOption({ ...o, payment_count: o.payment_count ?? null }, tax);
    await db.query(
      `INSERT INTO quote_options (quote_id, position, offer_id, lender_name, product_name, amount, term_months, rate_kind, rate, payment_frequency,
                                  payment_count, payment_amount, payment_overridden, fees, tax_lines, total_tax, total_fees, total_repayment,
                                  cost_of_borrowing, net_proceeds, estimated_apr, recommended, notes)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [quoteId, i, o.offer_id ?? null, o.lender_name, o.product_name ?? null, o.amount, o.term_months, o.rate_kind, o.rate, o.payment_frequency,
        m.payment_count, m.payment_amount, Boolean(o.payment_overridden), JSON.stringify(o.fees), JSON.stringify(m.tax_lines), m.total_tax,
        m.total_fees, m.total_repayment, m.cost_of_borrowing, m.net_proceeds, m.estimated_apr, Boolean(o.recommended), o.notes ?? null],
    );
  }
}

export async function offersOnFile(db: Db, applicationId: string) {
  const r = await db.query(
    `SELECT id::text AS id, lender_name, amount::float AS amount, rate_factor, term, payment_frequency, expiry_date::text AS expiry_date, recommended, status
       FROM offers WHERE application_id = $1 AND COALESCE(is_archived, false) = false AND status NOT IN ('rejected', 'declined') ORDER BY updated_at DESC LIMIT 20`,
    [applicationId],
  );
  return r.rows;
}

function quoteNumber(now: Date): string {
  return `Q-${now.toISOString().slice(2, 10).replace(/-/g, "")}-${randomUUID().slice(0, 5).toUpperCase()}`;
}

export type CreateInput = {
  applicationId: string; title?: string; message?: string | null; expiresOn?: string | null; offerIds?: string[]; options?: unknown;
  taxProvince?: unknown; userId: string | null;
};
type Fail = { ok: false; status: number; error: string };

export async function createQuote(input: CreateInput, db: Db = defaultDb(), now: Date = new Date()): Promise<{ ok: true; quote: QuoteView } | Fail> {
  const app = (await db.query(`SELECT id::text AS id, funded_currency FROM applications WHERE id::text = $1 LIMIT 1`, [input.applicationId])).rows[0];
  if (!app) return { ok: false, status: 404, error: "not_found" };
  let options: OptionPatch[] = [];
  if (input.options !== undefined) {
    const p = parseOptions(input.options);
    if (!p.ok) return { ok: false, status: 400, error: p.error };
    options = p.options;
  } else {
    const offers = await offersOnFile(db, app.id);
    const pick = input.offerIds?.length ? offers.filter((o: any) => input.offerIds!.includes(o.id)) : offers;
    options = pick.slice(0, LIMITS.options).map(optionFromOffer);
  }
  // The province whose sales tax applies to taxable fees: the one asked for, else the business's province.
  const province = input.taxProvince !== undefined ? normaliseProvince(input.taxProvince) : await applicationProvince(db, app.id);
  const expires = input.expiresOn && /^\d{4}-\d{2}-\d{2}$/.test(input.expiresOn) ? input.expiresOn
    : new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
  const id = randomUUID();
  await db.query(
    `INSERT INTO quotes (id, application_id, quote_number, title, message, currency, tax_province, expires_on, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, app.id, quoteNumber(now), clip(input.title, LIMITS.title) || "Your financing options", clip(input.message, LIMITS.message) || null,
      String(app.funded_currency ?? "").toUpperCase() === "USD" ? "USD" : "CAD", province, expires, input.userId],
  );
  await writeOptions(db, id, options, province);
  await event(db, id, "created", "staff", input.userId, { options: options.length });
  return { ok: true, quote: (await loadQuote(db, id, now))! };
}

export async function updateQuote(id: string, body: Record<string, unknown>, userId: string | null, db: Db = defaultDb()): Promise<{ ok: true; quote: QuoteView } | Fail> {
  const q = await loadQuote(db, id);
  if (!q) return { ok: false, status: 404, error: "not_found" };
  if (q.status !== "draft") return { ok: false, status: 409, error: "only_drafts_can_change" };
  if ("expires_on" in body && body.expires_on !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.expires_on))) return { ok: false, status: 400, error: "The expiry date must be a date (YYYY-MM-DD)." };
  if ("currency" in body && body.currency !== "CAD" && body.currency !== "USD") return { ok: false, status: 400, error: "The currency must be CAD or USD." };
  let province = q.tax_province;
  if ("tax_province" in body) {
    if (body.tax_province !== null && body.tax_province !== "" && !normaliseProvince(body.tax_province)) return { ok: false, status: 400, error: "Pick a Canadian province or territory for the sales tax, or none." };
    province = normaliseProvince(body.tax_province);
  }
  let options: OptionPatch[] | null = null;
  if ("options" in body) {
    const p = parseOptions(body.options);
    if (!p.ok) return { ok: false, status: 400, error: p.error };
    options = p.options;
  } else if (province !== q.tax_province) {
    options = q.options; // the same options, taxed at the new province's rate
  }
  await db.query(
    `UPDATE quotes SET title = COALESCE($2, title), message = CASE WHEN $3::boolean THEN $4 ELSE message END,
            expires_on = CASE WHEN $5::boolean THEN $6::date ELSE expires_on END, currency = COALESCE($7, currency), tax_province = $8, updated_at = now()
      WHERE id::text = $1`,
    [id, "title" in body ? clip(body.title, LIMITS.title) || "Your financing options" : null, "message" in body, clip(body.message, LIMITS.message) || null,
      "expires_on" in body, body.expires_on ?? null, "currency" in body ? body.currency : null, province],
  );
  if (options) await writeOptions(db, id, options, province);
  await event(db, id, "edited", "staff", userId, {});
  return { ok: true, quote: (await loadQuote(db, id))! };
}

export async function duplicateQuote(id: string, userId: string | null, db: Db = defaultDb()) {
  const q = await loadQuote(db, id);
  if (!q) return { ok: false as const, status: 404, error: "not_found" };
  return createQuote({ applicationId: q.application_id, title: q.title, message: q.message, options: q.options, taxProvince: q.tax_province, userId }, db);
}

// ------------------------------------------------------------------------------------------------ send
export type SendDeps = {
  db?: Db;
  storage?: Pick<StorageBackend, "put">;
  renderPdf?: (q: QuoteView, ctx: { businessName: string | null }) => Promise<Uint8Array>;
  notify?: (n: { applicationId: string; quoteId: string; phone: string | null; contactId: string | null }) => Promise<void>;
  now?: () => Date;
};

async function businessName(db: Db, applicationId: string): Promise<string | null> {
  const r = await db.query(`SELECT COALESCE(NULLIF(business_legal_name, ''), name) AS name FROM applications WHERE id::text = $1`, [applicationId]);
  return r.rows[0]?.name ?? null;
}

export async function quotePdf(q: QuoteView, db: Db = defaultDb(), render?: SendDeps["renderPdf"]): Promise<Uint8Array> {
  const fn = render ?? (await import("./pdf.js")).renderQuotePdf;
  return fn(q, { businessName: await businessName(db, q.application_id) });
}

/** Stores the PDF as the quote's document on the application (replacing the quote's previous copy). */
async function storePdf(db: Db, q: QuoteView, pdf: Uint8Array, storage: Pick<StorageBackend, "put">): Promise<string> {
  const buffer = Buffer.from(pdf);
  const filename = `Quote-${q.quote_number}.pdf`;
  const put = await storage.put({ buffer, filename, contentType: "application/pdf", pathPrefix: `applications/${q.application_id}/quotes` });
  const documentId = randomUUID();
  const hash = createHash("sha256").update(buffer).digest("hex");
  if (q.pdf_document_id) await db.query(`DELETE FROM documents WHERE id::text = $1 AND uploaded_by = 'system' AND document_type = 'quote_pdf'`, [q.pdf_document_id]);
  await db.query(
    `INSERT INTO documents (id, application_id, filename, hash, category, storage_path, blob_name, blob_url, size_bytes, status, ocr_status, uploaded_by, document_type, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Quote', $5, $5, $6, $7, 'accepted', 'skipped', 'system', 'quote_pdf', now(), now())`,
    [documentId, q.application_id, filename, hash, put.blobName, put.url, put.sizeBytes],
  );
  await db.query(
    `INSERT INTO document_versions (id, document_id, version, blob_name, hash, metadata, content, created_at) VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, now())`,
    [randomUUID(), documentId, put.blobName, hash, JSON.stringify({ source: "quote", quote_id: q.id }), put.url],
  );
  return documentId;
}

async function defaultNotify(n: { applicationId: string; quoteId: string; phone: string | null; contactId: string | null }): Promise<void> {
  const brand = brandName();
  await pool.query(
    `INSERT INTO communications_messages (id, type, direction, status, application_id, contact_id, silo, body, staff_name, cta_label, cta_action, created_at)
     VALUES (gen_random_uuid(), 'message', 'outbound', 'sent', $1, $2::uuid, COALESCE((SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1), 'BF'),
       $3, $4, 'View your quote', $5, now())`,
    [n.applicationId, n.contactId, "Your financing options are ready. Compare them and accept the one you want.", brand, `quote:${n.quoteId}`],
  );
  if (!n.phone) return;
  const { notifyClient } = await import("../services/notifications/notifyClient.js");
  const url = `${clientUrl()}/quote/${n.quoteId}`;
  await notifyClient({
    phone: n.phone, applicationId: n.applicationId, kind: "quote", categoryId: "APPLICATION_UPDATE",
    sms: `${brand}: your financing options are ready. View and accept: ${url}`, title: "Your quote is ready", body: "Compare your financing options and accept one.", url,
  });
}

export async function sendQuote(id: string, userId: string | null, deps: SendDeps = {}): Promise<{ ok: true; quote: QuoteView } | Fail> {
  const db = deps.db ?? defaultDb();
  const now = deps.now?.() ?? new Date();
  const q = await loadQuote(db, id, now);
  if (!q) return { ok: false, status: 404, error: "not_found" };
  if (q.status !== "draft") return { ok: false, status: 409, error: "already_sent" };
  if (!q.options.length) return { ok: false, status: 400, error: "add_an_option" };
  if (q.options.some((o) => o.payment_amount === null)) return { ok: false, status: 400, error: "every_option_needs_a_payment" };
  if (q.expires_on && q.expires_on < todayIso(now)) return { ok: false, status: 400, error: "expiry_in_the_past" };
  const sentView: QuoteView = { ...q, status: "sent", sent_at: now.toISOString() };
  let documentId: string | null = null;
  try {
    documentId = await storePdf(db, sentView, await quotePdf(sentView, db, deps.renderPdf), deps.storage ?? getStorage());
  } catch (err) {
    console.warn("[quotes] PDF not stored; the quote is still sent", { quoteId: id, message: (err as Error)?.message });
  }
  await db.query(`UPDATE quotes SET status = 'sent', sent_at = now(), sent_by = $2, pdf_document_id = COALESCE($3, pdf_document_id), updated_at = now() WHERE id::text = $1`, [id, userId, documentId]);
  await event(db, id, "sent", "staff", userId, { options: q.options.length });
  const person = (await db.query(
    `SELECT c.id::text AS contact_id, c.phone FROM applications a JOIN contacts c ON c.id = a.contact_id WHERE a.id::text = $1 LIMIT 1`, [q.application_id],
  )).rows[0];
  try {
    await (deps.notify ?? defaultNotify)({ applicationId: q.application_id, quoteId: id, phone: person?.phone ?? null, contactId: person?.contact_id ?? null });
  } catch (err) {
    console.warn("[quotes] client not told", { quoteId: id, message: (err as Error)?.message });
  }
  return { ok: true, quote: (await loadQuote(db, id, now))! };
}

export async function withdrawQuote(id: string, userId: string | null, db: Db = defaultDb()): Promise<boolean> {
  const r = await db.query(
    `UPDATE quotes SET status = 'withdrawn', withdrawn_at = now(), updated_at = now() WHERE id::text = $1 AND status IN ('draft', 'sent', 'viewed') RETURNING id`,
    [id],
  );
  if (r.rows[0]) await event(db, id, "withdrawn", "staff", userId, {});
  return Boolean(r.rows[0]);
}

// ------------------------------------------------------------------------------------------------ client side
async function tellOwner(db: Db, q: QuoteView, kind: "viewed" | "accepted" | "declined", text: string): Promise<void> {
  try {
    const owner = (await db.query(`SELECT owner_user_id::text AS uid FROM applications WHERE id::text = $1`, [q.application_id])).rows[0]?.uid;
    if (!owner) return;
    await db.query(
      `INSERT INTO notifications (user_id, application_id, type, title, body, ref_table, ref_id, context_url) VALUES ($1::uuid, $2, $3, $4, $5, 'quotes', $6, $7)`,
      [owner, q.application_id, `quote_${kind}`, `Quote ${kind}`, text, q.id, `/applications/${q.application_id}`],
    );
  } catch (err) {
    console.warn("[quotes] owner not notified", { quoteId: q.id, kind, message: (err as Error)?.message });
  }
}

/** The client opened the quote: counts the view; the first one moves it to viewed and tells the file's owner. */
export async function recordView(q: QuoteView, db: Db = defaultDb()): Promise<QuoteView> {
  if (q.status === "draft") return q;
  const first = !q.first_viewed_at;
  await db.query(
    `UPDATE quotes SET view_count = view_count + 1, last_viewed_at = now(), first_viewed_at = COALESCE(first_viewed_at, now()),
            status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END, updated_at = now() WHERE id::text = $1`,
    [q.id],
  );
  if (first) {
    await event(db, q.id, "viewed", "client", null, {});
    await tellOwner(db, q, "viewed", `The client opened quote ${q.quote_number}.`);
  }
  return (await loadQuote(db, q.id))!;
}

const ipHash = (ip: string | null) => (ip ? createHash("sha256").update(`bf-quote:${ip}`).digest("hex").slice(0, 32) : null);

/** Stages an offer for acceptance, exactly as POST /api/offers/:id/accept does. */
async function stageOffer(db: Db, offerId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE offers SET status = 'pending_acceptance', pending_at = NOW() WHERE id::text = $1 AND status NOT IN ('accepted', 'declined', 'expired')
     RETURNING id, application_id::text AS application_id`,
    [offerId],
  );
  const row = r.rows[0];
  if (!row) return false;
  await db.query(
    `UPDATE applications SET pending_acceptance_offer_id = $1::uuid, pending_acceptance_at = NOW(), updated_at = NOW() WHERE id::text = $2`,
    [row.id, row.application_id],
  );
  return true;
}

export async function acceptQuote(
  q: QuoteView, input: { optionId: string; name: string; agree: boolean; ip: string | null; userAgent: string | null }, db: Db = defaultDb(),
): Promise<{ ok: true; quote: QuoteView; offer_staged: boolean } | Fail> {
  if (!ANSWERABLE.has(q.status)) return { ok: false, status: 409, error: q.status === "expired" ? "quote_expired" : "quote_not_open" };
  const option = q.options.find((o) => o.id === input.optionId);
  if (!option) return { ok: false, status: 400, error: "pick_an_option" };
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 120);
  if (name.length < 2) return { ok: false, status: 400, error: "type_your_full_name" };
  if (!input.agree) return { ok: false, status: 400, error: "tick_to_agree" };
  const r = await db.query(
    `UPDATE quotes SET status = 'accepted', accepted_option_id = $2::uuid, accepted_name = $3, accepted_ip_hash = $4, accepted_user_agent = $5,
            accepted_at = now(), updated_at = now()
      WHERE id::text = $1 AND status IN ('sent', 'viewed') RETURNING id`,
    [q.id, option.id, name, ipHash(input.ip), (input.userAgent ?? "").slice(0, 300) || null],
  );
  if (!r.rows[0]) return { ok: false, status: 409, error: "quote_not_open" };
  let staged = false;
  if (option.offer_id) {
    try { staged = await stageOffer(db, option.offer_id); }
    catch (err) { console.warn("[quotes] offer not staged for acceptance", { quoteId: q.id, message: (err as Error)?.message }); }
  }
  await event(db, q.id, "accepted", "client", null, { option_id: option.id, lender: option.lender_name, offer_staged: staged });
  await tellOwner(db, q, "accepted", `The client accepted ${option.lender_name} on quote ${q.quote_number}.${staged ? " The offer is waiting for you to confirm acceptance on the Lenders tab." : ""}`);
  return { ok: true, quote: (await loadQuote(db, q.id))!, offer_staged: staged };
}

export async function declineQuote(q: QuoteView, reason: string, db: Db = defaultDb()): Promise<{ ok: true; quote: QuoteView } | Fail> {
  if (!ANSWERABLE.has(q.status)) return { ok: false, status: 409, error: "quote_not_open" };
  const why = reason.trim().slice(0, 500) || null;
  await db.query(`UPDATE quotes SET status = 'declined', declined_at = now(), decline_reason = $2, updated_at = now() WHERE id::text = $1 AND status IN ('sent', 'viewed')`, [q.id, why]);
  await event(db, q.id, "declined", "client", null, {});
  await tellOwner(db, q, "declined", `The client declined quote ${q.quote_number}${why ? `: ${why}` : "."}`);
  return { ok: true, quote: (await loadQuote(db, q.id))! };
}

/** What the client sees: no internal fields (who made it, the offer ids). */
export function clientQuote(q: QuoteView) {
  return {
    id: q.id, quote_number: q.quote_number, status: q.status, title: q.title, message: q.message, currency: q.currency, expires_on: q.expires_on,
    accepted_option_id: q.accepted_option_id, sent_at: q.sent_at, accepted_at: q.accepted_at, declined_at: q.declined_at,
    options: q.options.map(({ offer_id: _o, payment_overridden: _p, ...o }) => o),
  };
}
