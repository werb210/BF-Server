// BF_SERVER_DOCUMENT_CLASSIFIER_v196
// Classifies an uploaded document from the text OCR already extracted, so there
// is no second pass over the file and no new worker.
//
// Output is always a RequiredDocumentKey - the vocabulary the lender package
// builder, credit summary and processing services already resolve through. That
// is deliberate: emitting any other string would reintroduce the spelling drift
// v195 just closed.
import { REQUIRED_DOCUMENT_KEYS, type RequiredDocumentKey } from "../db/schema/requiredDocuments.js";
import { resolveExpectedDocumentKey } from "./documents/classifyDocument.js"; // BF_SERVER_MISFILED_DOCS_v262

// Above this the classifier will retag. Set high on purpose: moving a document
// out of the slot a lender is waiting on is far more damaging than leaving a
// mislabelled file where the applicant put it.
export const RETAG_CONFIDENCE = 0.75;

// Only the types where a wrong slot actually costs something. Equipment quotes
// and the long tail are scored but never auto-retagged.
export const RETAGGABLE: readonly RequiredDocumentKey[] = [
  "bank_statements_6_months",
  "financial_statements",
  "government_id",
  "void_cheque",
  "articles_of_incorporation",
  "tax_returns",
];

type Signal = { re: RegExp; weight: number };

// Weights are hand-set, not learned. A signal scores only once however many
// times it appears, so a statement that repeats "opening balance" on every page
// cannot run away with the score.
const SIGNALS: Partial<Record<RequiredDocumentKey, Signal[]>> = {
  bank_statements_6_months: [
    { re: /\bopening balance\b/i, weight: 3 },
    { re: /\bclosing balance\b/i, weight: 3 },
    { re: /\bwithdrawals?\b/i, weight: 2 },
    { re: /\bdeposits?\b/i, weight: 2 },
    { re: /\bstatement period\b/i, weight: 3 },
    { re: /\baccount number\b/i, weight: 1 },
    { re: /\btransit\b/i, weight: 1 },
  ],
  financial_statements: [
    { re: /\bbalance sheet\b/i, weight: 4 },
    { re: /\bincome statement\b/i, weight: 4 },
    { re: /\bstatement of (?:operations|earnings)\b/i, weight: 3 },
    { re: /\bretained earnings\b/i, weight: 3 },
    { re: /\btotal liabilities\b/i, weight: 2 },
    { re: /\bshareholders?'? equity\b/i, weight: 3 },
    { re: /\bnotice to reader\b/i, weight: 3 },
  ],
  government_id: [
    { re: /\bdriver'?s? licence\b/i, weight: 4 },
    { re: /\bdriver'?s? license\b/i, weight: 4 },
    { re: /\bpassport\b/i, weight: 4 },
    { re: /\bdate of birth\b/i, weight: 2 },
    { re: /\bexpiry\b/i, weight: 1 },
    { re: /\bissued\b/i, weight: 1 },
  ],
  void_cheque: [
    { re: /\bvoid\b/i, weight: 4 },
    { re: /\bpay to the order of\b/i, weight: 3 },
    { re: /\btransit\b/i, weight: 2 },
    { re: /\binstitution\b/i, weight: 2 },
  ],
  articles_of_incorporation: [
    { re: /\barticles of incorporation\b/i, weight: 5 },
    { re: /\bcertificate of incorporation\b/i, weight: 4 },
    { re: /\bcorporations? act\b/i, weight: 2 },
    { re: /\bregistered office\b/i, weight: 2 },
  ],
  tax_returns: [
    { re: /\bT2\b/, weight: 3 },
    { re: /\bT1 general\b/i, weight: 4 },
    { re: /\bnotice of assessment\b/i, weight: 4 },
    { re: /\bcanada revenue agency\b/i, weight: 3 },
    { re: /\btaxation year\b/i, weight: 2 },
  ],
};

export type Classification = {
  type: RequiredDocumentKey | null;
  confidence: number;
  shouldRetag: boolean;
};

export function classifyText(text: string, currentCategory?: string | null): Classification {
  const body = String(text ?? "").slice(0, 200_000);
  if (body.trim().length < 40) {
    return { type: null, confidence: 0, shouldRetag: false };
  }

  const scores: Array<{ key: RequiredDocumentKey; score: number }> = [];
  for (const [key, signals] of Object.entries(SIGNALS)) {
    let score = 0;
    let max = 0;
    for (const s of signals ?? []) {
      max += s.weight;
      if (s.re.test(body)) score += s.weight;
    }
    if (max > 0) scores.push({ key: key as RequiredDocumentKey, score: score / max });
  }
  scores.sort((a, b) => b.score - a.score);

  const best = scores[0];
  const runnerUp = scores[1];
  if (!best || best.score === 0) return { type: null, confidence: 0, shouldRetag: false };

  const margin = runnerUp ? Math.max(0, best.score - runnerUp.score) : best.score;
  const confidence = Math.min(1, best.score * (0.5 + 0.5 * (margin / Math.max(best.score, 0.0001))));
  // BF_SERVER_MISFILED_DOCS_v262 - compare meaning, not text: "6 months business banking statements" IS bank_statements_6_months.
  const sameAsCurrent = resolveExpectedDocumentKey(currentCategory) === best.key;
  const shouldRetag = !sameAsCurrent && confidence >= RETAG_CONFIDENCE && RETAGGABLE.includes(best.key);

  return { type: best.key, confidence: Number(confidence.toFixed(3)), shouldRetag };
}

export function isKnownKey(value: string): value is RequiredDocumentKey {
  return (REQUIRED_DOCUMENT_KEYS as readonly string[]).includes(value);
}
