// BF_SERVER_v872_PAYMENTS - payment links for broker fees (ported from KS-server #47 without the plan gate, and on
// Boreal's own Stripe account instead of Stripe Connect).
//
// Staff send a client a link for a fee from an application or a contact. The link is a Boreal URL
// (<server>/api/payments/pay/<token>) that opens a Stripe Checkout page on Boreal's Stripe account. The client pays by
// card or by Canadian pre-authorized debit (ACSS, CAD; a business mandate, sporadic). Card payments are paid at once;
// bank debits are "processing" for a few business days, then paid or failed.
//
// Messages: email (a transactional fee request about a deal the client is in) and text only with texting consent
// (express, or implied and still in time) and no STOP. Each send, payment, bank debit in progress and failure goes on
// the contact's timeline, shows on the application's Payment links panel, and tells the file's owner. A paid link on an
// application that has a QuickBooks fee invoice (v852) records a QuickBooks payment against that invoice and marks the
// invoice paid when nothing is left owing.
import { randomBytes } from "node:crypto";
import { brandName, brokerageTimeZone, sendClientMail } from "../settingsPack/boreal.js";
import { CONSENT_SQL } from "../services/smsConsent.js";
import { qboConfigured } from "../services/quickbooks/qboConfig.js";
import { feeAmountFor } from "../services/quickbooks/feeInvoices.js";
import { getConnection, qboRequest, type QboDeps } from "../services/quickbooks/qboClient.js";
import { stripeRequest, type StripeConfig } from "./stripe.js";

export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const METHODS = ["card", "acss_debit"] as const;
export type Method = (typeof METHODS)[number];
export const METHOD_LABEL: Record<Method, string> = { card: "Card", acss_debit: "Bank debit (pre-authorized debit)" };
export const MIN_CENTS = 100; // $1.00
export const MAX_CENTS = 100_000_000; // $1,000,000
export const QBO_BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360];
const CHECKOUT_LIFETIME_MS = 23 * 60 * 60 * 1000; // Stripe allows at most 24 h.
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type LinkRow = {
  id: string; token: string; application_id: string | null; contact_id: string | null; silo: string; description: string; amount_cents: number;
  currency: string; methods: string[]; status: string; livemode: boolean | null; checkout_session_id: string | null;
  checkout_url: string | null; checkout_expires_at: string | Date | null; checkout_count: number; payment_intent_id: string | null;
  payment_method_type: string | null; amount_received_cents: number | null; paid_at: string | Date | null; processing_at: string | Date | null;
  failed_at: string | Date | null; failure_message: string | null; cancelled_at: string | Date | null; sent_channels: string[];
  sent_at: string | Date | null; expires_at: string | Date; quickbooks_status: string; quickbooks_payment_id: string | null;
  quickbooks_error: string | null; quickbooks_attempts: number; created_by: string | null; created_at: string | Date; updated_at: string | Date;
};

export const serverUrl = () => String(process.env.PUBLIC_BASE_URL || "https://server.boreal.financial").replace(/\/+$/, "");
export const newToken = () => randomBytes(24).toString("base64url");
export const payUrl = (token: string) => `${serverUrl()}/api/payments/pay/${encodeURIComponent(token)}`;
export const money = (cents: number, currency = "cad") =>
  `${(cents / 100).toLocaleString("en-CA", { style: "currency", currency: currency.toUpperCase() })}${currency.toLowerCase() === "cad" ? "" : ` ${currency.toUpperCase()}`}`;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

// ------------------------------------------------------------------ creating links
export type CreateInput = { application_id?: unknown; contact_id?: unknown; amount?: unknown; description?: unknown; methods?: unknown; expires_days?: unknown };
export type Valid = { applicationId: string | null; contactId: string | null; amountCents: number; description: string; methods: Method[]; expiresDays: number };

export function validateCreate(raw: CreateInput): { ok: true; value: Valid } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const applicationId = String(raw.application_id ?? "").trim() || null;
  const contactId = String(raw.contact_id ?? "").trim() || null;
  if (!applicationId && !contactId) errors.record = "Send the link from an application or a contact.";
  if (applicationId && !/^[0-9a-f-]{36}$/i.test(applicationId)) errors.application_id = "Unknown application.";
  if (contactId && !/^[0-9a-f-]{36}$/i.test(contactId)) errors.contact_id = "Unknown contact.";
  const amount = Number(String(raw.amount ?? "").replace(/[$,\s]/g, ""));
  const amountCents = Number.isFinite(amount) ? Math.round(amount * 100) : NaN;
  if (!Number.isFinite(amountCents) || amountCents < MIN_CENTS) errors.amount = "Enter an amount of at least $1.00.";
  else if (amountCents > MAX_CENTS) errors.amount = "Payment links are limited to $1,000,000.";
  const description = String(raw.description ?? "").trim();
  if (!description) errors.description = "Say what the payment is for (for example: Broker fee).";
  if (description.length > 200) errors.description = "Keep the description under 200 characters.";
  const list = Array.isArray(raw.methods) ? raw.methods.map(String) : [...METHODS];
  const methods = METHODS.filter((m) => list.includes(m));
  if (!methods.length) errors.methods = "Allow card, bank debit, or both.";
  const days = raw.expires_days === undefined || raw.expires_days === "" ? 30 : Math.round(Number(raw.expires_days));
  if (!Number.isFinite(days) || days < 1 || days > 90) errors.expires_days = "Links can stay open for 1 to 90 days.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { applicationId, contactId, amountCents, description, methods, expiresDays: days } };
}

/** The contact the link is for (the application's contact when sent from an application) and the record's silo. */
export async function resolveRecord(db: Q, v: Valid): Promise<{ contactId: string | null; silo: string } | null> {
  if (v.applicationId) {
    const r = await db.query(`SELECT contact_id::text AS contact_id, silo FROM applications WHERE id::text = $1`, [v.applicationId]);
    if (!r.rows[0]) return null;
    return { contactId: v.contactId ?? r.rows[0].contact_id ?? null, silo: String(r.rows[0].silo ?? "BF").toUpperCase() };
  }
  const c = await db.query(`SELECT id::text AS id, silo FROM contacts WHERE id = $1::uuid`, [v.contactId]);
  if (!c.rows[0]) return null;
  return { contactId: v.contactId, silo: String(c.rows[0].silo ?? "BF").toUpperCase() };
}

/** The signed fee agreement's fee on the application (v775 terms: fixed, else percent of the funded or requested amount). */
export async function suggestedFee(db: Q, applicationId: string): Promise<{ amount: number; description: string } | null> {
  const r = await db.query(
    `SELECT a.requested_amount, a.funded_amount, a.funded_at, m.status, m.fee_percent::text AS fee_percent, m.fee_amount::text AS fee_amount
       FROM applications a LEFT JOIN media_fee_agreements m ON m.application_id = a.id::text WHERE a.id::text = $1`, [applicationId]);
  const row = r.rows[0];
  if (!row || row.status !== "signed") return null;
  const n = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const terms = { percent: n(row.fee_percent), fixed: n(row.fee_amount) };
  const amount = feeAmountFor(terms, n(row.funded_at ? row.funded_amount : null) ?? n(row.requested_amount));
  if (amount === null || !(amount > 0)) return null;
  const pct = terms.percent !== null && terms.percent >= 0 ? terms.percent : 2;
  return { amount, description: terms.fixed !== null ? "Broker fee" : `Broker fee (${Number(pct.toFixed(3))}% of ${row.funded_at ? "funding" : "the amount requested"})` };
}

export async function createLink(db: Q, v: Valid, record: { contactId: string | null; silo: string }, livemode: boolean, actor: string | null): Promise<LinkRow> {
  const r = await db.query(
    `INSERT INTO payment_links (token, application_id, contact_id, silo, description, amount_cents, currency, methods, livemode, expires_at, created_by)
     VALUES ($1, $2, $3::uuid, $4, $5, $6, 'cad', $7::text[], $8, now() + make_interval(days => $9::int), $10::uuid) RETURNING *`,
    [newToken(), v.applicationId, record.contactId, record.silo, v.description, v.amountCents, v.methods, livemode, v.expiresDays, actor]);
  return r.rows[0] as LinkRow;
}

export async function linkById(db: Q, id: string): Promise<LinkRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return ((await db.query(`SELECT * FROM payment_links WHERE id = $1::uuid`, [id])).rows[0] as LinkRow) ?? null;
}

export async function linkByToken(db: Q, token: string): Promise<LinkRow | null> {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  return ((await db.query(`SELECT * FROM payment_links WHERE token = $1`, [token])).rows[0] as LinkRow) ?? null;
}

/** The contact's timeline (application id kept on the row, so the file's history shows it too). */
export async function timeline(db: Q, link: Pick<LinkRow, "contact_id" | "application_id">, eventType: string, title: string, detail: string, actor: string | null = null): Promise<void> {
  if (!link.contact_id) return;
  try {
    await db.query(
      `INSERT INTO crm_timeline_events (contact_id, application_id, event_type, payload, actor_user_id) VALUES ($1::uuid, $2, $3, $4::jsonb, $5::uuid)`,
      [link.contact_id, link.application_id, eventType, JSON.stringify({ title, detail }), actor]);
  } catch (err) {
    console.error("[payments] timeline event not recorded", { eventType, message: err instanceof Error ? err.message : String(err) });
  }
}

/** Tells the file's owner (or the contact's owner) about a payment, in the portal's notifications. Never throws. */
export async function tellOwner(db: Q, link: Pick<LinkRow, "id" | "contact_id" | "application_id">, title: string, body: string): Promise<void> {
  try {
    const owner = link.application_id
      ? (await db.query(`SELECT owner_user_id::text AS uid FROM applications WHERE id::text = $1`, [link.application_id])).rows[0]?.uid
      : link.contact_id ? (await db.query(`SELECT owner_id::text AS uid FROM contacts WHERE id = $1::uuid`, [link.contact_id])).rows[0]?.uid : null;
    if (!owner) return;
    await db.query(
      `INSERT INTO notifications (user_id, application_id, type, title, body, ref_table, ref_id, context_url) VALUES ($1::uuid, $2, 'payment_link', $3, $4, 'payment_links', $5, $6)`,
      [owner, link.application_id, title, body, link.id, link.application_id ? `/applications/${link.application_id}` : link.contact_id ? `/crm/contacts/${link.contact_id}` : null]);
  } catch (err) {
    console.error("[payments] owner not notified", { linkId: link.id, message: err instanceof Error ? err.message : String(err) });
  }
}

// ------------------------------------------------------------------ sending
export type SendDeps = {
  email: (to: string, subject: string, html: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  sms: (to: string, body: string) => Promise<{ ok: boolean; error?: string }>;
};

export function defaultSendDeps(): SendDeps {
  return {
    email: (to, subject, html, text) => sendClientMail({ to: [to], subject, html, text }),
    async sms(to, body) {
      try {
        const { sendSms } = await import("../modules/notifications/sms.service.js");
        await sendSms({ to, message: body, track: { kind: "payment_link" } as any }, { enqueueOnFailure: false });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function linkMessage(link: Pick<LinkRow, "token" | "description" | "amount_cents" | "currency" | "methods" | "expires_at">, firstName: string | null) {
  const brand = brandName();
  const url = payUrl(link.token);
  const amount = money(link.amount_cents, link.currency);
  const how = link.methods.includes("acss_debit") && link.methods.includes("card") ? "by card or by pre-authorized debit from your bank account"
    : link.methods.includes("acss_debit") ? "by pre-authorized debit from your bank account" : "by card";
  const until = new Date(link.expires_at).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: brokerageTimeZone() });
  const hi = firstName ? `Hi ${firstName},` : "Hi,";
  const subject = `Payment request from ${brand}: ${amount}`;
  const text = [hi, "", `${brand} has sent you a secure payment link for ${link.description} (${amount}).`,
    `You can pay ${how}: ${url}`, `The link is open until ${until}.`, "", brand].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#0B1F3A;line-height:1.5">
<p>${esc(hi)}</p><p>${esc(brand)} has sent you a secure payment link for <strong>${esc(link.description)}</strong> (${esc(amount)}).</p>
<p><a href="${esc(url)}" style="display:inline-block;padding:10px 18px;background:#0B1F3A;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold">Pay ${esc(amount)}</a></p>
<p style="color:#374151;font-size:13px">You can pay ${esc(how)}. Payments are processed securely by Stripe. The link is open until ${esc(until)}.</p>
<p>${esc(brand)}</p></div>`;
  const sms = `${brand}: payment request for ${link.description} (${amount}). Pay securely here: ${url} Reply STOP to opt out.`;
  return { subject, text, html, sms };
}

export type SendResult = { sent: string[]; refused: Record<string, string> };

/** Sends the link by the channels asked for, within consent. Never throws on a delivery failure (it is reported). */
export async function sendLink(db: Q, link: LinkRow, want: { email?: boolean; sms?: boolean }, deps: SendDeps, actor: string | null): Promise<SendResult> {
  const out: SendResult = { sent: [], refused: {} };
  if (!link.contact_id) {
    if (want.email || want.sms) out.refused.contact = "This link has no contact to send it to. Copy the link instead.";
    return out;
  }
  const c = (await db.query(
    `SELECT COALESCE(NULLIF(c.first_name, ''), NULLIF(split_part(c.name, ' ', 1), '')) AS first_name, c.email, c.phone,
            COALESCE(c.sms_opt_out, false) AS sms_out, (${CONSENT_SQL}) AS sms_ok
       FROM contacts c WHERE c.id = $1::uuid`, [link.contact_id])).rows[0] as
    { first_name: string | null; email: string | null; phone: string | null; sms_out: boolean; sms_ok: boolean } | undefined;
  if (!c) { out.refused.contact = "The contact no longer exists."; return out; }
  const m = linkMessage(link, c.first_name);
  if (want.email) {
    if (!c.email) out.refused.email = "The contact has no email address.";
    else {
      const r = await deps.email(c.email, m.subject, m.html, m.text);
      if (r.ok) out.sent.push("email"); else out.refused.email = `The email could not be sent (${r.error ?? "unknown error"}).`;
    }
  }
  if (want.sms) {
    if (!c.phone) out.refused.sms = "The contact has no phone number.";
    else if (c.sms_out) out.refused.sms = "The contact replied STOP to texts.";
    else if (!c.sms_ok) out.refused.sms = "The contact has not agreed to texts (or their implied consent has expired). Send by email instead.";
    else {
      const r = await deps.sms(c.phone, m.sms);
      if (r.ok) out.sent.push("sms"); else out.refused.sms = `The text could not be sent (${r.error ?? "unknown error"}).`;
    }
  }
  if (out.sent.length) {
    await db.query(
      `UPDATE payment_links SET sent_channels = ARRAY(SELECT DISTINCT unnest(sent_channels || $2::text[])), sent_at = now(), updated_at = now() WHERE id = $1::uuid`,
      [link.id, out.sent]);
    await timeline(db, link, "payment_link_sent", `Payment link sent: ${money(link.amount_cents, link.currency)}`,
      `${link.description} - by ${out.sent.map((s) => (s === "sms" ? "text" : s)).join(" and ")}`, actor);
  }
  return out;
}

// ------------------------------------------------------------------ the client opens the link
export type OpenResult =
  | { kind: "redirect"; url: string }
  | { kind: "page"; status: number; title: string; message: string };

export function isExpired(link: Pick<LinkRow, "expires_at">, now = new Date()): boolean {
  return new Date(link.expires_at).getTime() <= now.getTime();
}

/** Where the client goes: the open Checkout page (reused while it lasts) or a page saying why not. */
export async function openCheckout(db: Q, cfg: StripeConfig, link: LinkRow, opts: { customerEmail?: string | null; now?: Date } = {}): Promise<OpenResult> {
  const now = opts.now ?? new Date();
  const brand = brandName();
  const amount = money(link.amount_cents, link.currency);
  if (link.status === "paid") return { kind: "page", status: 200, title: "Already paid", message: `This payment of ${amount} has been received. Thank you.` };
  if (link.status === "processing") return { kind: "page", status: 200, title: "Payment in progress", message: `Your bank payment of ${amount} is being processed. This usually takes 3 to 5 business days. There is nothing more to do.` };
  if (link.status === "cancelled") return { kind: "page", status: 410, title: "Link cancelled", message: `This payment link was cancelled. Please contact ${brand} for a new one.` };
  if (isExpired(link, now) || link.status === "expired") return { kind: "page", status: 410, title: "Link expired", message: `This payment link has expired. Please contact ${brand} for a new one.` };
  if (link.livemode !== null && link.livemode !== cfg.livemode) {
    // A link made with test keys never opens on live keys (and the other way round).
    return { kind: "page", status: 503, title: "Payments unavailable", message: `This payment link is no longer valid. Please contact ${brand} for a new one.` };
  }
  if (link.checkout_url && link.checkout_expires_at && new Date(link.checkout_expires_at).getTime() - now.getTime() > 5 * 60_000) {
    return { kind: "redirect", url: link.checkout_url };
  }
  const attempt = Number(link.checkout_count ?? 0) + 1;
  const base = payUrl(link.token);
  const session = await stripeRequest<any>(cfg, "POST", "/checkout/sessions", {
    mode: "payment",
    line_items: [{ quantity: 1, price_data: { currency: link.currency, unit_amount: link.amount_cents, product_data: { name: link.description.slice(0, 200) } } }],
    payment_method_types: link.methods,
    ...(link.methods.includes("acss_debit") ? { payment_method_options: { acss_debit: { mandate_options: { payment_schedule: "sporadic", transaction_type: "business" }, verification_method: "automatic" } } } : {}),
    success_url: `${base}/done`,
    cancel_url: base,
    client_reference_id: link.id,
    customer_email: opts.customerEmail || undefined,
    expires_at: Math.floor((now.getTime() + CHECKOUT_LIFETIME_MS) / 1000),
    metadata: { boreal_payment_link: link.id, application_id: link.application_id ?? "", contact_id: link.contact_id ?? "" },
    payment_intent_data: { description: link.description.slice(0, 200), metadata: { boreal_payment_link: link.id, application_id: link.application_id ?? "" } },
  }, { idempotencyKey: `bf-pl-${link.id}-${attempt}` });
  if (!session?.url || !session?.id) throw new Error("stripe_checkout_not_created");
  await db.query(
    `UPDATE payment_links SET checkout_session_id = $2, checkout_url = $3, checkout_expires_at = to_timestamp($4), checkout_count = $5,
            status = CASE WHEN status = 'failed' THEN 'open' ELSE status END, updated_at = now() WHERE id = $1::uuid`,
    [link.id, session.id, session.url, Number(session.expires_at ?? Math.floor((now.getTime() + CHECKOUT_LIFETIME_MS) / 1000)), attempt]);
  return { kind: "redirect", url: String(session.url) };
}

export function resultPage(title: string, message: string): string {
  const brand = brandName();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - ${esc(brand)}</title>
<style>body{margin:0;font-family:Arial,sans-serif;background:#f3f4f6;color:#111827}main{max-width:480px;margin:48px auto;padding:28px;background:#ffffff;border-radius:12px;border:1px solid #d1d5db}h1{font-size:22px;margin:0 0 12px;color:#0B1F3A}p{font-size:16px;line-height:1.5;color:#1f2937}small{color:#374151}</style>
</head><body><main><h1>${esc(title)}</h1><p>${esc(message)}</p><small>${esc(brand)}</small></main></body></html>`;
}

// ------------------------------------------------------------------ Stripe events
export type HandledEvent = { handled: boolean; linkId?: string; status?: string };

async function linkForSession(db: Q, session: any): Promise<LinkRow | null> {
  const id = String(session?.metadata?.boreal_payment_link ?? session?.client_reference_id ?? "");
  const byId = id ? await linkById(db, id) : null;
  if (byId) return byId;
  if (!session?.id) return null;
  return ((await db.query(`SELECT * FROM payment_links WHERE checkout_session_id = $1`, [String(session.id)])).rows[0] as LinkRow) ?? null;
}

/** Applies one verified Stripe event. Checkout sessions that are not Boreal payment links are ignored. */
export async function handleStripeEvent(db: Q, event: any, deps: { recordInQuickBooks?: (linkId: string) => Promise<void> } = {}): Promise<HandledEvent> {
  const type = String(event?.type ?? "");
  if (!type.startsWith("checkout.session.")) return { handled: false };
  const session = event?.data?.object ?? {};
  const link = await linkForSession(db, session);
  if (!link) return { handled: false };
  const amount = money(Number(session.amount_total ?? link.amount_cents), link.currency);
  const pi = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;

  if (type === "checkout.session.expired") {
    await db.query(`UPDATE payment_links SET checkout_url = NULL, checkout_expires_at = NULL, updated_at = now() WHERE id = $1::uuid AND checkout_session_id = $2`, [link.id, String(session.id ?? "")]);
    return { handled: true, linkId: link.id, status: link.status };
  }
  const paidNow = (type === "checkout.session.completed" && session.payment_status === "paid") || type === "checkout.session.async_payment_succeeded";
  if (paidNow) {
    if (link.status === "paid") return { handled: true, linkId: link.id, status: "paid" };
    // Bank debit (ACSS) is the only delayed method: paid at checkout means card, paid later means bank debit.
    const method = type === "checkout.session.async_payment_succeeded" ? "acss_debit" : "card";
    await db.query(
      `UPDATE payment_links SET status = 'paid', paid_at = now(), payment_intent_id = COALESCE($2, payment_intent_id),
              payment_method_type = COALESCE($3, payment_method_type), amount_received_cents = $4, failure_message = NULL,
              quickbooks_status = CASE WHEN application_id IS NULL THEN 'not_applicable' ELSE 'pending' END, updated_at = now()
        WHERE id = $1::uuid`,
      [link.id, pi, method, Number(session.amount_total ?? link.amount_cents)]);
    await timeline(db, link, "payment_received", `Payment received: ${amount}`, `${link.description} - ${method === "acss_debit" ? "bank debit" : "card"}`);
    await tellOwner(db, link, `Payment received: ${amount}`, `${link.description} was paid by ${method === "acss_debit" ? "bank debit" : "card"}.`);
    if (link.application_id && deps.recordInQuickBooks) await deps.recordInQuickBooks(link.id);
    return { handled: true, linkId: link.id, status: "paid" };
  }
  if (type === "checkout.session.completed") { // ACSS: the debit is submitted, the money arrives in a few days
    if (link.status === "paid") return { handled: true, linkId: link.id, status: "paid" };
    await db.query(
      `UPDATE payment_links SET status = 'processing', processing_at = now(), payment_intent_id = COALESCE($2, payment_intent_id),
              payment_method_type = 'acss_debit', updated_at = now() WHERE id = $1::uuid`, [link.id, pi]);
    await timeline(db, link, "payment_processing", `Bank debit authorized: ${amount}`, `${link.description} - the payment clears in about 3 to 5 business days`);
    return { handled: true, linkId: link.id, status: "processing" };
  }
  if (type === "checkout.session.async_payment_failed") {
    await db.query(
      `UPDATE payment_links SET status = 'failed', failed_at = now(), failure_message = 'The bank debit failed.', checkout_url = NULL, checkout_expires_at = NULL, updated_at = now()
        WHERE id = $1::uuid AND status <> 'paid'`, [link.id]);
    await timeline(db, link, "payment_failed", `Payment failed: ${amount}`, `${link.description} - the bank debit did not go through. The client can use the same link to try again.`);
    await tellOwner(db, link, `Payment failed: ${amount}`, `The bank debit for ${link.description} did not go through. The client can use the same link to try again.`);
    return { handled: true, linkId: link.id, status: "failed" };
  }
  return { handled: false };
}

/** True the first time an event id is seen (Stripe retries deliveries). */
export async function firstDelivery(db: Q, event: any): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO stripe_webhook_events (event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [String(event?.id ?? ""), String(event?.type ?? "")]);
  return r.rows.length > 0;
}

// ------------------------------------------------------------------ QuickBooks
/**
 * Records the Stripe payment in QuickBooks against the application's v852 fee invoice, when there is one, and marks the
 * invoice paid when nothing is left owing. Outcome on the link: recorded | not_applicable (no invoice yet, QuickBooks
 * not set up or not connected) | retrying | failed. Never throws.
 */
export async function recordInQuickBooks(db: Q, linkId: string, deps: QboDeps = {}): Promise<string> {
  const link = await linkById(db, linkId);
  if (!link || link.status !== "paid" || !link.application_id) return "not_applicable";
  if (link.quickbooks_status === "recorded" || link.quickbooks_status === "not_applicable") return link.quickbooks_status;
  const set = async (status: string, fields: { paymentId?: string | null; error?: string | null; attempts?: number }) => {
    await db.query(
      `UPDATE payment_links SET quickbooks_status = $2, quickbooks_payment_id = COALESCE($3, quickbooks_payment_id), quickbooks_error = $4,
              quickbooks_attempts = COALESCE($5, quickbooks_attempts), updated_at = now() WHERE id = $1::uuid`,
      [link.id, status, fields.paymentId ?? null, fields.error ?? null, fields.attempts ?? null]);
    return status;
  };
  const qdeps: QboDeps = { db, ...deps };
  try {
    if (!qboConfigured(qdeps.env)) return set("not_applicable", {});
    const invoice = (await db.query(`SELECT qbo_invoice_id, qbo_customer_id, status FROM qbo_fee_invoices WHERE application_id = $1`, [link.application_id])).rows[0];
    if (!invoice?.qbo_invoice_id || !(await getConnection(qdeps))) return set("not_applicable", {});
    const current = (await qboRequest("GET", `invoice/${encodeURIComponent(String(invoice.qbo_invoice_id))}`, undefined, qdeps))?.Invoice ?? {};
    const balance = Number(current.Balance ?? 0);
    const paid = round2(Number(link.amount_received_cents ?? link.amount_cents) / 100);
    const apply = round2(Math.min(balance, paid));
    let paymentId: string | null = null;
    if (apply > 0) {
      const r = await qboRequest("POST", "payment", {
        CustomerRef: { value: String(current?.CustomerRef?.value ?? invoice.qbo_customer_id ?? "") }, TotalAmt: apply,
        Line: [{ Amount: apply, LinkedTxn: [{ TxnId: String(invoice.qbo_invoice_id), TxnType: "Invoice" }] }],
        PaymentRefNum: (link.payment_intent_id ?? "").slice(0, 21) || undefined,
        PrivateNote: `Paid online through Stripe (${link.payment_intent_id ?? link.id}) - Boreal payment link ${link.id}`,
      }, qdeps, { requestid: `bf-stripe-${link.id}`.slice(0, 50) });
      paymentId = r?.Payment?.Id ? String(r.Payment.Id) : null;
      if (!paymentId) throw new Error("quickbooks_payment_not_created");
    }
    if (balance - apply <= 0.004) {
      await db.query(
        `UPDATE qbo_fee_invoices SET status = 'paid', qbo_payment_id = COALESCE($2, qbo_payment_id), synced_at = now(), updated_at = now() WHERE application_id = $1`,
        [link.application_id, paymentId]);
    }
    console.info({ event: "payment_link_quickbooks_recorded", linkId: link.id, invoiceId: invoice.qbo_invoice_id, amount: apply });
    return set("recorded", { paymentId, error: null, attempts: 0 });
  } catch (err) {
    const attempts = Number(link.quickbooks_attempts ?? 0) + 1;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    console.error("[payments] QuickBooks payment not recorded", { linkId: link.id, attempts, message });
    return set(attempts > QBO_BACKOFF_MINUTES.length ? "failed" : "retrying", { error: message, attempts });
  }
}

/** Worker pass: QuickBooks retries (with backoff) and expiring open links. */
export async function runPaymentsPass(db: Q): Promise<{ quickbooks: number; expired: number }> {
  const due = await db.query(
    `SELECT id::text AS id, quickbooks_attempts, updated_at FROM payment_links
      WHERE quickbooks_status IN ('pending', 'retrying') AND status = 'paid' ORDER BY updated_at LIMIT 25`);
  let n = 0;
  for (const row of due.rows as Array<{ id: string; quickbooks_attempts: number; updated_at: string }>) {
    const wait = QBO_BACKOFF_MINUTES[Math.min(Math.max(0, Number(row.quickbooks_attempts) - 1), QBO_BACKOFF_MINUTES.length - 1)]!;
    if (Number(row.quickbooks_attempts) > 0 && Date.now() - new Date(row.updated_at).getTime() < wait * 60_000) continue;
    await recordInQuickBooks(db, row.id);
    n++;
  }
  const expired = await db.query(`UPDATE payment_links SET status = 'expired', updated_at = now() WHERE status IN ('open', 'failed') AND expires_at <= now() RETURNING id`);
  return { quickbooks: n, expired: expired.rows.length };
}

// ------------------------------------------------------------------ views and the report
export function linkView(l: LinkRow) {
  return {
    id: l.id, url: payUrl(l.token), application_id: l.application_id, contact_id: l.contact_id, description: l.description,
    amount: l.amount_cents / 100, amount_cents: l.amount_cents, currency: l.currency, methods: l.methods,
    status: isExpired(l) && (l.status === "open" || l.status === "failed") ? "expired" : l.status,
    payment_method_type: l.payment_method_type, amount_received: l.amount_received_cents === null ? null : l.amount_received_cents / 100,
    paid_at: l.paid_at ? new Date(l.paid_at).toISOString() : null, processing_at: l.processing_at ? new Date(l.processing_at).toISOString() : null,
    failed_at: l.failed_at ? new Date(l.failed_at).toISOString() : null, failure_message: l.failure_message,
    sent_channels: l.sent_channels ?? [], sent_at: l.sent_at ? new Date(l.sent_at).toISOString() : null,
    expires_at: new Date(l.expires_at).toISOString(), created_at: new Date(l.created_at).toISOString(),
    quickbooks_status: l.quickbooks_status, quickbooks_error: l.quickbooks_error,
  };
}

/**
 * Fee payments by payment link over the last N days, in one silo. Run inside scopedRequest: for a person who sees only
 * some records, the applications and contacts views hide the rest, so a link on a record they cannot see drops out.
 */
export async function paymentsReport(db: Q, q: { days?: unknown; silo?: unknown } = {}) {
  const days = Math.min(1825, Math.max(7, Math.round(Number(q.days ?? 90)) || 90));
  const silo = ["BF", "BI", "SLF"].includes(String(q.silo ?? "").toUpperCase()) ? String(q.silo).toUpperCase() : "BF";
  const r = await db.query(
    `SELECT l.status, l.amount_cents, l.amount_received_cents, l.paid_at, l.created_at, l.expires_at, l.payment_method_type
       FROM payment_links l
       LEFT JOIN applications a ON a.id::text = l.application_id
       LEFT JOIN contacts c ON c.id = l.contact_id
      WHERE l.created_at >= now() - make_interval(days => $1::int) AND l.silo = $2
        AND (l.application_id IS NULL OR a.id IS NOT NULL) AND (l.contact_id IS NULL OR c.id IS NOT NULL)`, [days, silo]);
  const rows = r.rows as Array<{ status: string; amount_cents: number; amount_received_cents: number | null; paid_at: string | null; expires_at: string; payment_method_type: string | null }>;
  const sum = (xs: typeof rows, f: (x: (typeof rows)[number]) => number) => xs.reduce((s, x) => s + f(x), 0) / 100;
  const paid = rows.filter((x) => x.status === "paid");
  const live = (x: (typeof rows)[number]) => (x.status === "open" || x.status === "failed") && new Date(x.expires_at).getTime() > Date.now();
  const months = new Map<string, number>();
  for (const p of paid) {
    const m = new Date(p.paid_at ?? Date.now()).toISOString().slice(0, 7);
    months.set(m, (months.get(m) ?? 0) + Number(p.amount_received_cents ?? p.amount_cents));
  }
  return {
    days, silo,
    sent: rows.length,
    paid: { count: paid.length, amount: sum(paid, (x) => Number(x.amount_received_cents ?? x.amount_cents)), card: paid.filter((x) => x.payment_method_type === "card").length, bank_debit: paid.filter((x) => x.payment_method_type === "acss_debit").length },
    processing: { count: rows.filter((x) => x.status === "processing").length, amount: sum(rows.filter((x) => x.status === "processing"), (x) => x.amount_cents) },
    outstanding: { count: rows.filter(live).length, amount: sum(rows.filter(live), (x) => x.amount_cents) },
    failed: rows.filter((x) => x.status === "failed").length,
    by_month: [...months.entries()].sort().map(([month, cents]) => ({ month, amount: cents / 100 })),
  };
}
