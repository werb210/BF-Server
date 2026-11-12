// KS_SERVER_LICENSEE_DOCUMENTS - the data Keystone already collects, as fill-in keys a licensee's own document can be
// matched to. The licensee's form is filled from these; a question on their form that matches none of them becomes an
// extra question in their client wizard (its answer is "extra.<field>").
import type { ApplicationPdfInputs, PdfOwner } from "../signnow/pdfBuilder.js";

export type DataField = { key: string; label: string; words: string[] };

const ownerFields = (n: 1 | 2): DataField[] => {
  const who = n === 1 ? "Owner 1 / applicant" : "Owner 2 / co-applicant";
  const w = n === 1 ? ["applicant", "owner", "guarantor", "principal", "borrower", "signer"] : ["co applicant", "owner 2", "second owner", "partner", "guarantor 2", "co borrower"];
  const f = (k: string, label: string, words: string[]): DataField => ({ key: `owner${n}.${k}`, label: `${who}: ${label}`, words: words.flatMap((x) => [x, ...w.map((p) => `${p} ${x}`)]) });
  return [
    f("full_name", "full name", ["name", "full name", "print name", "printed name"]),
    f("first_name", "first name", ["first name", "given name"]),
    f("last_name", "last name", ["last name", "surname", "family name"]),
    f("email", "email", ["email", "e mail", "email address"]),
    f("phone", "phone", ["phone", "cell", "mobile", "telephone", "home phone"]),
    f("address", "home address (one line)", ["home address", "residential address", "address"]),
    f("street", "street", ["street", "street address"]),
    f("city", "city", ["city", "town"]),
    f("province", "province or state", ["province", "state", "prov"]),
    f("postal", "postal or ZIP code", ["postal code", "postal", "zip", "zip code"]),
    f("dob", "date of birth", ["date of birth", "dob", "birth date", "birthdate"]),
    f("sin", "SIN / SSN", ["sin", "social insurance number", "ssn", "social security number"]),
    f("ownership", "ownership %", ["ownership", "ownership percent", "percent owned", "% owned", "ownership %"]),
    f("credit_score", "credit score (self-reported)", ["credit score", "beacon"]),
  ];
};

export const DATA_FIELDS: DataField[] = [
  { key: "today", label: "Today's date", words: ["date", "today", "todays date", "application date", "date signed"] },
  { key: "broker.name", label: "Your brokerage's name", words: ["broker", "brokerage", "broker name", "submitted by"] },
  { key: "application.reference", label: "File reference", words: ["reference", "file number", "application number", "app id"] },
  { key: "business.legal_name", label: "Business legal name", words: ["legal name", "business name", "company name", "legal business name", "corporation name", "business legal name", "company"] },
  { key: "business.dba", label: "Operating name (DBA)", words: ["dba", "operating name", "trade name", "doing business as", "operating as"] },
  { key: "business.structure", label: "Business structure", words: ["structure", "business type", "entity type", "legal structure", "type of business", "incorporation type"] },
  { key: "business.since", label: "In business since", words: ["in business since", "date established", "start date", "established", "date of incorporation", "incorporation date"] },
  { key: "business.years", label: "Years in business", words: ["years in business", "time in business", "years operating"] },
  { key: "business.employees", label: "Number of employees", words: ["employees", "number of employees", "staff", "headcount"] },
  { key: "business.phone", label: "Business phone", words: ["business phone", "company phone", "phone", "telephone"] },
  { key: "business.website", label: "Website", words: ["website", "web site", "url"] },
  { key: "business.address", label: "Business address (one line)", words: ["business address", "company address", "address", "location"] },
  { key: "business.street", label: "Business street", words: ["business street", "street"] },
  { key: "business.city", label: "Business city", words: ["business city", "city"] },
  { key: "business.province", label: "Business province or state", words: ["business province", "province", "state"] },
  { key: "business.postal", label: "Business postal code", words: ["business postal code", "postal code", "zip"] },
  { key: "business.industry", label: "Industry", words: ["industry", "type of industry", "nature of business", "business description", "naics"] },
  { key: "business.annual_revenue", label: "Annual revenue", words: ["annual revenue", "annual sales", "gross revenue", "yearly revenue", "revenue"] },
  { key: "business.monthly_revenue", label: "Monthly revenue", words: ["monthly revenue", "monthly sales", "average monthly deposits"] },
  { key: "business.accounts_receivable", label: "Accounts receivable", words: ["accounts receivable", "receivables", "a r"] },
  { key: "business.fixed_assets", label: "Fixed assets", words: ["fixed assets", "assets"] },
  { key: "deal.amount", label: "Amount requested", words: ["amount requested", "loan amount", "amount", "funding amount", "requested amount", "amount of financing"] },
  { key: "deal.product", label: "Product / type of financing", words: ["product", "type of financing", "loan type", "financing type", "looking for"] },
  { key: "deal.purpose", label: "Purpose of funds", words: ["purpose", "use of funds", "purpose of funds", "purpose of loan", "reason"] },
  { key: "deal.equipment_value", label: "Equipment value", words: ["equipment value", "equipment cost", "purchase price"] },
  { key: "deal.collateral", label: "Collateral available", words: ["collateral", "security offered"] },
  ...ownerFields(1),
  ...ownerFields(2),
  // Offers and fees, for an agreement or term sheet template.
  { key: "offer.lender", label: "Offer: lender", words: ["lender", "lender name", "funder"] },
  { key: "offer.amount", label: "Offer: amount", words: ["approved amount", "offer amount", "funded amount", "principal"] },
  { key: "offer.rate", label: "Offer: rate or factor", words: ["rate", "interest rate", "factor rate", "factor"] },
  { key: "offer.term", label: "Offer: term", words: ["term", "term length", "months"] },
  { key: "offer.payment_frequency", label: "Offer: payment frequency", words: ["payment frequency", "frequency", "payments"] },
  { key: "offer.payment", label: "Offer: payment amount", words: ["payment", "payment amount", "monthly payment", "weekly payment"] },
  { key: "offer.expiry", label: "Offer: expiry date", words: ["expiry", "expiration", "expires", "valid until"] },
  // OFFER_PRICING_v1 - our own term sheet: the fees and what the client actually receives and repays.
  { key: "offer.setup_fee", label: "Offer: set-up fee", words: ["setup fee", "set-up fee", "set up fee", "origination fee", "admin fee"] },
  { key: "offer.proceeds_fee", label: "Offer: fee from proceeds", words: ["fee from proceeds", "deducted from proceeds", "holdback"] },
  { key: "offer.funds_to_client", label: "Offer: funds to the client", words: ["net proceeds", "net funding", "funds to client", "amount advanced"] },
  { key: "offer.total_repaid", label: "Offer: total repaid", words: ["total repayment", "total repaid", "total payback", "repayment amount"] },
  // BF_SERVER_v952_INVOICE_TEMPLATES - an invoice template: its number, dates and money lines.
  // The words are invoice-specific on purpose: plain words such as "amount", "date" or "fee" belong to the application,
  // offer and fee fields above, and must keep matching those.
  { key: "invoice.number", label: "Invoice: number", words: ["invoice number", "invoice no", "invoice num", "inv no", "inv number"] },
  { key: "invoice.date", label: "Invoice: date", words: ["invoice date", "date of invoice", "date issued", "issue date"] },
  { key: "invoice.due_date", label: "Invoice: due date", words: ["due date", "payment due", "payment due date", "pay by"] },
  { key: "invoice.description", label: "Invoice: what it is for", words: ["invoice description", "description of services", "services rendered", "line item", "item description"] },
  { key: "invoice.amount", label: "Invoice: amount before tax", words: ["subtotal", "sub total", "amount before tax", "net amount"] },
  { key: "invoice.tax", label: "Invoice: tax", words: ["gst", "hst", "sales tax", "tax amount", "gst hst"] },
  { key: "invoice.total", label: "Invoice: total due", words: ["total due", "amount due", "balance due", "invoice total", "total amount due"] },
  { key: "fee.percent", label: "Broker fee %", words: ["fee percent", "broker fee %", "fee %", "commission %"] },
  { key: "fee.amount", label: "Broker fee amount", words: ["fee", "broker fee", "fee amount", "commission"] },
];
export const DATA_FIELD_KEYS = new Set(DATA_FIELDS.map((f) => f.key));

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());
const money = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? "$" + Math.round(n).toLocaleString("en-CA") : String(v);
};
const line = (...parts: unknown[]) => parts.map(s).filter(Boolean).join(", ");

function ownerValues(n: 1 | 2, o: PdfOwner | undefined): Record<string, string> {
  if (!o) return {};
  const p = `owner${n}.`;
  return {
    [p + "full_name"]: [o.firstName, o.lastName].map(s).filter(Boolean).join(" "),
    [p + "first_name"]: s(o.firstName), [p + "last_name"]: s(o.lastName), [p + "email"]: s(o.email), [p + "phone"]: s(o.phone),
    [p + "address"]: line(o.street, o.city, o.province, o.postal), [p + "street"]: s(o.street), [p + "city"]: s(o.city),
    [p + "province"]: s(o.province), [p + "postal"]: s(o.postal), [p + "dob"]: s(o.dob), [p + "sin"]: s(o.sin),
    [p + "ownership"]: o.ownership === null || o.ownership === undefined ? "" : `${o.ownership}%`, [p + "credit_score"]: s(o.creditScore),
  };
}

export type InvoiceValues = { number: string; date: string; due_date: string | null; description: string; amount: number; tax: number; total: number };
export type OfferValues = { lender?: unknown; amount?: unknown; rate?: unknown; term?: unknown; payment_frequency?: unknown; payment?: unknown; expiry?: unknown;
  setup_fee?: unknown; proceeds_fee?: unknown; funds_to_client?: unknown; total_repaid?: unknown };

/** Every value we have for a file, by key. Empty strings for what we do not have. */
export function valuesFor(input: {
  app: ApplicationPdfInputs; brokerName: string; extras?: Record<string, unknown>; offer?: OfferValues | null; fee?: { percent?: unknown; amount?: unknown } | null; today?: Date; invoice?: InvoiceValues | null;
}): Record<string, string> {
  const { app } = input;
  const b = app.business ?? {}, f = app.funding ?? {}, p = app.product ?? {};
  const out: Record<string, string> = {
    "today": (input.today ?? new Date()).toISOString().slice(0, 10),
    "broker.name": s(input.brokerName),
    "application.reference": s(app.applicationId).slice(0, 8).toUpperCase(),
    "business.legal_name": s(b.legalName), "business.dba": s(b.dba), "business.structure": s(b.structure),
    "business.since": s(b.inBusinessSince), "business.years": s(f.yearsInBusiness), "business.employees": s(b.employees),
    "business.phone": s(b.phone), "business.website": s(b.website),
    "business.address": line(b.address, b.city, b.province, b.postal), "business.street": s(b.address), "business.city": s(b.city),
    "business.province": s(b.province), "business.postal": s(b.postal), "business.industry": s(f.industry),
    "business.annual_revenue": /^[\d$,.\s]+$/.test(s(f.annualRevenue)) ? money(f.annualRevenue) : s(f.annualRevenue),
    "business.monthly_revenue": /^[\d$,.\s]+$/.test(s(f.monthlyRevenue)) ? money(f.monthlyRevenue) : s(f.monthlyRevenue),
    "business.accounts_receivable": money(f.accountsReceivable), "business.fixed_assets": money(f.fixedAssets),
    "deal.amount": money(p.amountRequested), "deal.product": s(p.category ?? p.lookingFor), "deal.purpose": s(f.purposeOfFunds),
    "deal.equipment_value": money(p.equipmentValue), "deal.collateral": typeof f.availableCollateral === "number" ? money(f.availableCollateral) : s(f.availableCollateral),
    ...ownerValues(1, app.owners?.[0]),
    ...ownerValues(2, app.owners?.[1]),
  };
  const o = input.offer;
  if (o) Object.assign(out, {
    "offer.lender": s(o.lender), "offer.amount": money(o.amount), "offer.rate": s(o.rate), "offer.term": s(o.term),
    "offer.payment_frequency": s(o.payment_frequency), "offer.payment": money(o.payment), "offer.expiry": s(o.expiry).slice(0, 10),
    "offer.setup_fee": money(o.setup_fee), "offer.proceeds_fee": money(o.proceeds_fee), "offer.funds_to_client": money(o.funds_to_client),
    "offer.total_repaid": money(o.total_repaid),
  });
  if (input.fee) Object.assign(out, { "fee.percent": input.fee.percent === null || input.fee.percent === undefined || input.fee.percent === "" ? "" : `${input.fee.percent}%`, "fee.amount": money(input.fee.amount) });
  const inv = input.invoice;
  if (inv) Object.assign(out, { "invoice.number": inv.number, "invoice.date": inv.date, "invoice.due_date": inv.due_date ?? "", "invoice.description": inv.description,
    "invoice.amount": money(inv.amount), "invoice.tax": money(inv.tax), "invoice.total": money(inv.total) });
  for (const [k, v] of Object.entries(input.extras ?? {})) out[`extra.${k}`] = typeof v === "boolean" ? (v ? "Yes" : "No") : s(v);
  return out;
}
