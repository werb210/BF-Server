// BF_SERVER_DOC_CLASSIFY_v139
import { REQUIRED_DOCUMENT_KEYS, type RequiredDocumentKey } from "../../db/schema/requiredDocuments.js";

export type ClassificationResult = { documentType: RequiredDocumentKey | null; confidence: number; matched: string[]; alternative: RequiredDocumentKey | null; reason: string };
type Rule = { type: RequiredDocumentKey; strong: string[]; weak?: string[]; veto?: string[] };
type Scored = { type: RequiredDocumentKey; score: number; matched: string[] };

const STRONG_WEIGHT = 3;
const WEAK_WEIGHT = 1;
export const MIN_SCORE = 3;
export const CONFIDENCE_FLOOR = 0.5;

const RULES: Rule[] = [
  { type: "bank_statements_6_months", strong: ["statement of account", "account summary", "opening balance", "closing balance", "withdrawals and deposits"], weak: ["transaction", "deposit", "withdrawal", "branch", "account number", "balance forward", "e-transfer"], veto: ["notice of assessment"] },
  { type: "government_id", strong: ["driver's licence", "drivers license", "driver licence", "passport", "date of birth", "identification card"], weak: ["licence class", "expiry", "issued", "sex", "height", "nationality"] },
  { type: "void_cheque", strong: ["void", "pre-authorized debit", "transit number", "institution number"], weak: ["pay to the order of", "memo", "routing"] },
  { type: "articles_of_incorporation", strong: ["articles of incorporation", "certificate of incorporation", "business corporations act", "articles of amendment"], weak: ["registered office", "incorporator", "share structure", "corporate access number"] },
  { type: "business_license", strong: ["business licence", "business license", "licence to operate", "municipal licence"], weak: ["licence number", "valid until", "premises"] },
  { type: "personal_net_worth", strong: ["personal financial statement", "personal net worth", "statement of personal net worth"], weak: ["assets", "liabilities", "net worth", "sba form 413"] },
  { type: "equipment_quote", strong: ["quotation", "quote no", "quote number", "proposal for equipment"], weak: ["model", "serial", "unit price", "valid for", "equipment"], veto: ["invoice no", "invoice number"] },
  { type: "equipment_invoice", strong: ["invoice no", "invoice number", "bill to", "amount due"], weak: ["model", "serial", "unit price", "subtotal", "gst", "hst"] },
  { type: "purchase_order", strong: ["purchase order", "p.o. number", "po number"], weak: ["ship to", "vendor", "order date", "line item"] },
  { type: "accounts_receivable_aging", strong: ["accounts receivable aging", "a/r aging", "aged receivables", "receivables aging"], weak: ["current", "31-60", "61-90", "over 90", "customer"] },
  { type: "accounts_payable_aging", strong: ["accounts payable aging", "a/p aging", "aged payables", "payables aging"], weak: ["current", "31-60", "61-90", "over 90", "vendor", "supplier"] },
  { type: "tax_returns", strong: ["notice of assessment", "t2 corporation income tax return", "income tax and benefit return", "form 1120", "form 1040", "t1 general"], weak: ["taxation year", "canada revenue agency", "internal revenue service", "taxable income", "refund"] },
  { type: "financial_statements", strong: ["balance sheet", "income statement", "statement of financial position", "statement of operations", "notice to reader", "review engagement report"], weak: ["retained earnings", "cost of goods sold", "gross profit", "shareholders equity", "fiscal year ended"] },
  { type: "lease_agreement", strong: ["lease agreement", "this lease", "landlord and tenant", "term of lease"], weak: ["lessor", "lessee", "premises", "rent", "renewal"] },
  { type: "real_estate_schedule", strong: ["schedule of real estate", "real estate owned", "property schedule"], weak: ["legal description", "appraised value", "mortgage balance", "title"] },
  { type: "org_chart_beneficial_ownership", strong: ["beneficial ownership", "organizational chart", "org chart", "ownership structure"], weak: ["subsidiary", "holdco", "percentage owned", "parent company"] },
  { type: "equipment_list", strong: ["equipment list", "schedule of equipment", "asset listing"], weak: ["serial number", "year", "make", "model", "appraised"] },
  { type: "professional_advisors", strong: ["professional advisors", "list of advisors"], weak: ["accountant", "solicitor", "lawyer", "insurance broker", "banker"] },
  { type: "cra_view_only_authorization", strong: ["authorize a representative", "represent a client", "rc59", "view-only access"], weak: ["canada revenue agency", "business number", "authorization"] },
];

export function normalizeText(raw: string | null | undefined): string {
  return String(raw ?? "").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  if (!needle) return count;
  while (count < 3) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

export function scoreAll(text: string): Scored[] {
  const clean = normalizeText(text);
  if (!clean) return [];
  return RULES.flatMap((rule) => {
    if (rule.veto?.some((phrase) => clean.includes(normalizeText(phrase)))) return [];
    let score = 0;
    const matched: string[] = [];
    for (const [phrases, weight] of [[rule.strong, STRONG_WEIGHT], [rule.weak ?? [], WEAK_WEIGHT]] as const) {
      for (const phrase of phrases) {
        const hits = countOccurrences(clean, normalizeText(phrase));
        if (hits) { score += weight * hits; matched.push(phrase); }
      }
    }
    return score ? [{ type: rule.type, score, matched }] : [];
  }).sort((a, b) => b.score - a.score);
}

export function classifyDocumentText(text: string | null | undefined): ClassificationResult {
  const scored = scoreAll(String(text ?? ""));
  if (!scored.length) return { documentType: null, confidence: 0, matched: [], alternative: null, reason: "no recognisable document markers found" };
  const best = scored[0];
  const runnerUp = scored[1] ?? null;
  if (best.score < MIN_SCORE) return { documentType: null, confidence: 0, matched: best.matched, alternative: null, reason: "too little evidence to identify the document" };
  const share = best.score / scored.reduce((sum, item) => sum + item.score, 0);
  const confidence = Math.round(share * Math.min(1, best.score / (STRONG_WEIGHT * 3)) * 100) / 100;
  return { documentType: best.type, confidence, matched: best.matched, alternative: runnerUp?.type ?? null, reason: `matched ${best.matched.slice(0, 4).map((phrase) => `"${phrase}"`).join(", ")}${runnerUp ? `; next closest was ${runnerUp.type}` : ""}` };
}

export type MismatchVerdict = { mismatch: boolean; expected: string; detected: RequiredDocumentKey | null; confidence: number; message: string };
export function checkAgainstExpected(text: string | null | undefined, expected: string | null | undefined): MismatchVerdict {
  const result = classifyDocumentText(text);
  const want = normalizeText(expected).replace(/[\s-]+/g, "_");
  const base = { expected: String(expected ?? ""), detected: result.documentType, confidence: result.confidence };
  if (!want || !result.documentType || result.confidence < CONFIDENCE_FLOOR) return { ...base, mismatch: false, message: "not confident enough to question this upload" };
  if (result.documentType === want) return { ...base, mismatch: false, message: "document matches the requirement" };
  return { ...base, mismatch: true, message: `this looks like a ${result.documentType.replace(/_/g, " ")} rather than the ${want.replace(/_/g, " ")} it was uploaded for` };
}

export function classifiableTypes(): RequiredDocumentKey[] {
  return RULES.map((rule) => rule.type).filter((type) => (REQUIRED_DOCUMENT_KEYS as readonly string[]).includes(type));
}
