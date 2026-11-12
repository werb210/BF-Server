// KS_SERVER_LICENSEE_DOCUMENTS - where a licensee's own documents are used. Each function returns null when the
// licensee has not uploaded one for that purpose (or it cannot be filled), and the caller keeps the built-in document.
import { db, type Q } from "../brokerTools/common.js";
const brandName = (): string => "Boreal Financial";
import type { ApplicationPdfInputs } from "../signnow/pdfBuilder.js";
import { valuesFor, type OfferValues } from "./catalog.js";
import { fillDocument, type SignerRole } from "./fill.js";
import { activeDocument } from "./repo.js";

async function extrasOf(q: Q, applicationId: string): Promise<Record<string, unknown>> {
  try {
    const r = await q.query(`SELECT metadata->'extra_answers' AS x FROM applications WHERE id::text = $1 LIMIT 1`, [applicationId]);
    const x = r.rows[0]?.x;
    return x && typeof x === "object" ? x : {};
  } catch (err) {
    console.warn("[licensee-docs] extra answers not read", { applicationId, message: err instanceof Error ? err.message : String(err) });
    return {};
  }
}

const ownerSigners = (inputs: ApplicationPdfInputs, howMany: number): SignerRole[] =>
  inputs.owners.slice(0, Math.max(1, howMany)).map((o, i) => ({ role: `Owner ${i + 1}`, name: [o.firstName, o.lastName].filter(Boolean).join(" "), email: String(o.email ?? "") }));

/** The licensee's application form, filled, for every owner on the file (roles "Owner 1", "Owner 2", ...). */
export async function licenseeApplicationPdf(inputs: ApplicationPdfInputs, q: Q = db()): Promise<Uint8Array | null> {
  const doc = await activeDocument(q, "application_form");
  if (!doc) return null;
  try {
    const values = valuesFor({ app: inputs, brokerName: brandName(), extras: await extrasOf(q, inputs.applicationId) });
    // Every owner on the file signs (review fix): boxes on the form are used where they exist, and anyone without one
    // gets a line on the signature page added at the end.
    return await fillDocument({ name: doc.name, format: doc.format, file: doc.file, fields: doc.fields }, values, ownerSigners(inputs, inputs.owners.length), `${brandName()} - ${doc.name}`);
  } catch (err) {
    console.warn("[licensee-docs] application form not filled; using the built-in application", { applicationId: inputs.applicationId, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** The licensee's client / fee agreement, filled, for one signer under the given SignNow role. */
export async function licenseeAgreementPdf(applicationId: string, signer: { role: string; name: string | null; email: string | null }, fee: { percent?: unknown; amount?: unknown } | null = null, q: Q = db()): Promise<Uint8Array | null> {
  const doc = await activeDocument(q, "client_agreement");
  if (!doc) return null;
  try {
    const { loadApplicationForPdf } = await import("../signnow/sendApplicationForSignature.js");
    const inputs = await loadApplicationForPdf(applicationId);
    const values = valuesFor({ app: inputs, brokerName: brandName(), extras: await extrasOf(q, applicationId), fee });
    return await fillDocument({ name: doc.name, format: doc.format, file: doc.file, fields: doc.fields }, values, [{ role: signer.role, name: signer.name ?? "", email: signer.email ?? "" }], `${brandName()} - ${doc.name}`);
  } catch (err) {
    console.warn("[licensee-docs] agreement not filled; using the built-in agreement", { applicationId, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** The licensee's term sheet, filled with an offer. No signature tags: it becomes the offer's term sheet, and Send for
 *  signature adds the client's signature box as it does for a lender's term sheet. Throws with a readable reason. */
export async function licenseeTermSheetPdf(offerId: string, q: Q = db()): Promise<{ pdf: Uint8Array; applicationId: string; name: string }> {
  const r = await q.query(
    `SELECT application_id::text AS application_id, lender_name, amount, rate_factor, term, payment_frequency, expiry_date,
            client_rate, term_months, broker_fee, setup_fee, proceeds_fee, lender_commission, term_sheet_mode FROM offers WHERE id::text = $1 LIMIT 1`, [offerId]);
  const o = r.rows[0];
  if (!o?.application_id) throw Object.assign(new Error("Offer not found."), { status: 404 });
  // BF_SERVER_v948_TERM_SHEET_BY_TYPE - the template for this file's type of financing, else the general one.
  const { toBucketId, productCategoryLabel } = await import("../modules/applications/productCategoryChange.js");
  const cat = (await q.query(`SELECT product_category FROM applications WHERE id::text = $1 LIMIT 1`, [o.application_id])).rows[0]?.product_category ?? null;
  const type = toBucketId(cat);
  const doc = await activeDocument(q, "term_sheet", type);
  if (!doc) throw Object.assign(new Error(`Upload a term sheet template${type ? ` for ${productCategoryLabel(type)}, or a general one,` : ""} in Settings > Term sheet templates first.`), { status: 409 });
  const { loadApplicationForPdf } = await import("../signnow/sendApplicationForSignature.js");
  const inputs = await loadApplicationForPdf(o.application_id);
  // OFFER_PRICING_v1 - our term sheet means we buy the deal: no lender name, the client's rate (not the lender's) and our fees.
  const { revenueFor, clientRateText } = await import("../offers/pricing.js");
  const rev = revenueFor({ amount: o.amount, lender_rate: o.rate_factor, client_rate: o.client_rate, term: o.term, term_months: o.term_months,
    broker_fee: o.broker_fee, setup_fee: o.setup_fee, proceeds_fee: o.proceeds_fee, lender_commission: o.lender_commission });
  // BF_SERVER_v943_OFFER_TEMPLATE_MODE - on a template (the lender's terms on our sheet) the lender stays named.
  const offer: OfferValues = { lender: o.term_sheet_mode === "template" ? o.lender_name : "", amount: o.amount, rate: clientRateText(o.rate_factor, o.client_rate), term: o.term || (rev.term_months ? `${rev.term_months} months` : null),
    payment_frequency: o.payment_frequency, payment: rev.client_payment, expiry: o.expiry_date ? new Date(o.expiry_date).toISOString() : null,
    setup_fee: o.setup_fee, proceeds_fee: o.proceeds_fee, funds_to_client: rev.funds_to_client, total_repaid: rev.client_total_repaid };
  const fee = o.broker_fee === null || o.broker_fee === undefined ? null : { amount: o.broker_fee };
  const values = valuesFor({ app: inputs, brokerName: brandName(), extras: await extrasOf(q, o.application_id), offer, fee });
  const pdf = await fillDocument({ name: doc.name, format: doc.format, file: doc.file, fields: doc.fields }, values, [], `${brandName()} - ${doc.name}`);
  return { pdf, applicationId: o.application_id, name: doc.name };
}
