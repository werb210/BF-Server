// BF_SERVER_v906_OFFER_READER - reads a lender's offer or term sheet (PDF, scan or photo) and proposes what it says:
// amount, rate or factor, term, payment and frequency, expiry, fees, and the funding conditions. Nothing is saved here:
// the Lenders tab uses it to fill in the term sheet form (and start a quote from it), and the Funding tab shows the
// conditions for the broker to confirm before any is added to the file.
// Text: pdf-parse for text PDFs, else Document Intelligence (the same reader the broker-import uses); fields: one
// OpenAI JSON call (the same pattern as the credit summary's financial extraction).
import { sharedOpenAI } from "../lib/sharedClients.js";

export const FREQUENCIES = ["daily", "weekly", "biweekly", "semimonthly", "monthly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export type ProposedCondition = { title: string; description: string | null; owner: "staff" | "client" | "lender"; requires_document: boolean };
export type ReadOffer = {
  lender_name: string | null;
  product_name: string | null;
  amount: number | null;
  rate_kind: "interest_rate" | "factor_rate" | null;
  rate: number | null;
  term_months: number | null;
  payment_amount: number | null;
  payment_frequency: Frequency | null;
  expiry_date: string | null;
  fees: Array<{ label: string; amount: number }>;
  conditions: ProposedCondition[];
};

const PROMPT = [
  "You read commercial lending offers, approvals, commitment letters and term sheets for a Canadian/US loan broker.",
  "Return ONLY JSON with these keys (null when the document does not say):",
  '{"lender_name": string, "product_name": string, "amount": number (approved/funded amount, dollars),',
  '"rate_kind": "interest_rate" | "factor_rate", "rate": number (interest as a yearly percent, e.g. 8.5; or a factor such as 1.32),',
  '"term_months": number, "payment_amount": number (one regular payment, dollars),',
  '"payment_frequency": "daily" | "weekly" | "biweekly" | "semimonthly" | "monthly", "expiry_date": "YYYY-MM-DD" (offer expiry),',
  '"fees": [{"label": string, "amount": number}],',
  '"conditions": [{"title": short imperative line, e.g. "Signed personal guarantee from each owner",',
  '"description": string or null, "owner": "client" | "staff" | "lender", "requires_document": boolean}]}',
  "Conditions are the things that must happen before funding (documents to provide, guarantees, insurance, site visits, verifications).",
  "Use only what the document says. Do not invent figures. Amounts are plain numbers without $ or commas.",
].join("\n");

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown, max = 200): string | null => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s ? s.slice(0, max) : null;
};

/** Cleans what the model returned: numbers are numbers, dates are dates, nothing out of range survives. */
export function normalizeOffer(raw: any): ReadOffer {
  const freqRaw = String(raw?.payment_frequency ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  const freq: Frequency | null = freqRaw === "biweekly" || freqRaw === "everytwoweeks" ? "biweekly"
    : freqRaw === "semimonthly" || freqRaw === "twiceamonth" ? "semimonthly"
    : (FREQUENCIES as readonly string[]).includes(freqRaw) ? (freqRaw as Frequency) : null;
  let rate = num(raw?.rate);
  let rateKind: ReadOffer["rate_kind"] = raw?.rate_kind === "factor_rate" ? "factor_rate" : raw?.rate_kind === "interest_rate" ? "interest_rate" : null;
  if (rate !== null && rateKind === null) rateKind = rate > 1 && rate < 2 ? "factor_rate" : "interest_rate";
  if (rate !== null && rateKind === "interest_rate" && rate > 0 && rate < 1) rate = Math.round(rate * 10000) / 100; // 0.085 -> 8.5
  if (rate !== null && (rate <= 0 || rate > 200)) rate = null;
  const amount = num(raw?.amount);
  const term = num(raw?.term_months);
  const payment = num(raw?.payment_amount);
  const expiry = typeof raw?.expiry_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.expiry_date.trim()) ? raw.expiry_date.trim() : null;
  const fees = (Array.isArray(raw?.fees) ? raw.fees : [])
    .map((f: any) => ({ label: str(f?.label, 80), amount: num(f?.amount) }))
    .filter((f: { label: string | null; amount: number | null }) => f.label && f.amount !== null && f.amount > 0)
    .slice(0, 10) as Array<{ label: string; amount: number }>;
  const seen = new Set<string>();
  const conditions = (Array.isArray(raw?.conditions) ? raw.conditions : [])
    .map((c: any): ProposedCondition | null => {
      const title = str(c?.title, 200);
      if (!title) return null;
      const owner = c?.owner === "staff" || c?.owner === "lender" ? c.owner : "client";
      return { title, description: str(c?.description, 1000), owner, requires_document: c?.requires_document === true };
    })
    .filter((c: ProposedCondition | null): c is ProposedCondition => {
      if (!c) return false;
      const k = c.title.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 40);
  return {
    lender_name: str(raw?.lender_name, 120),
    product_name: str(raw?.product_name, 120),
    amount: amount !== null && amount > 0 && amount < 1e9 ? amount : null,
    rate_kind: rate === null ? null : rateKind,
    rate,
    term_months: term !== null && term > 0 && term <= 600 ? Math.round(term) : null,
    payment_amount: payment !== null && payment > 0 && payment < 1e8 ? payment : null,
    payment_frequency: freq,
    expiry_date: expiry,
    fees,
    conditions,
  };
}

export type OfferReaderDeps = {
  text: (buffer: Buffer, mime: string) => Promise<string>;
  ask: (text: string) => Promise<unknown>;
};

export const defaultOfferReaderDeps = (): OfferReaderDeps => ({
  text: async (buffer, mime) => {
    const { documentText } = await import("../services/brokerImport/extract.js");
    return String((await documentText(buffer, mime)) ?? "");
  },
  ask: async (text) => {
    if (!process.env.OPENAI_API_KEY) throw new OfferReadError("ai_not_set_up", "The AI reader is not set up on the server (OPENAI_API_KEY).");
    const r = await sharedOpenAI(process.env.OPENAI_API_KEY).chat.completions.create({
      model: process.env.CREDIT_LLM_MODEL || process.env.BANKING_LLM_MODEL || "gpt-5.4-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: PROMPT }, { role: "user", content: text.slice(0, 60000) }],
    });
    try { return JSON.parse(r.choices[0]?.message?.content ?? "{}"); } catch { return {}; }
  },
});

export class OfferReadError extends Error {
  constructor(public readonly code: "no_text" | "ai_not_set_up" | "unsupported", message: string) {
    super(message);
    this.name = "OfferReadError";
  }
}

export async function readOfferDocument(buffer: Buffer, mime: string, deps: OfferReaderDeps = defaultOfferReaderDeps()): Promise<{ offer: ReadOffer; textChars: number }> {
  if (!/^application\/pdf$|^image\/|^text\//.test(mime)) {
    throw new OfferReadError("unsupported", "Upload the offer as a PDF or a photo to read it.");
  }
  const text = await deps.text(buffer, mime);
  if (text.replace(/\s/g, "").length < 40) {
    throw new OfferReadError("no_text", "No text could be read from this file. Check it is the lender's offer, or type the terms in.");
  }
  return { offer: normalizeOffer(await deps.ask(text)), textChars: text.length };
}
