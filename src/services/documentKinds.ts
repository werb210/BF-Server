// BF_SERVER_DOC_SHARING_v635
// One name per kind of document. The same document reaches us under many labels -
// "2 pieces of Government Issued ID" (Request Items), "Government ID" (wizard),
// "owner_photo_id" (SBA) - and they must count as the same thing, or the client is
// asked twice for a document they already sent.
//
// personal = about the person (shared across every application that client has);
// otherwise about the business (shared only between applications for the same business).
type Rule = { key: string; personal: boolean; match: RegExp };

const RULES: Rule[] = [
  { key: "government_id", personal: true, match: /government|gov't|\bgov\b|photo[\s_]*id|driver'?s?[\s_]*licen[cs]e|passport|identification|\bid\b/i },
  { key: "personal_tax_returns", personal: true, match: /personal[\s_]*tax|\bt1\b|notice[\s_]*of[\s_]*assessment/i },
  { key: "bank_statements", personal: false, match: /bank(ing)?[\s_]*statements?/i },
  { key: "void_cheque", personal: false, match: /\bvoid\b|cheque|\bpad\b|pre[\s_-]*authori[sz]ed[\s_]*debit/i },
  { key: "business_tax_returns", personal: false, match: /business[\s_]*tax|corporate[\s_]*tax|\bt2\b/i },
  { key: "accountant_financials", personal: false, match: /accountant|year[\s_-]*end[\s_]*financ/i },
  { key: "interim_pnl", personal: false, match: /\bp\s*(&|and|n)\s*l\b|profit[\s_]*(and|&)[\s_]*loss|income[\s_]*statement/i },
  { key: "balance_sheet", personal: false, match: /balance[\s_]*sheet/i },
  { key: "accounts_receivable", personal: false, match: /\ba\s*\/\s*r\b|accounts?[\s_]*receivable/i },
  { key: "accounts_payable", personal: false, match: /\ba\s*\/\s*p\b|accounts?[\s_]*payable/i },
];

/** The kind of document a label means ("2 pieces of Government Issued ID" -> "government_id"). */
export function canonicalDocKey(label: unknown): string {
  const s = String(label ?? "").trim();
  if (!s) return "";
  for (const r of RULES) if (r.match.test(s)) return r.key;
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Personal documents follow the client to all their applications. */
export function isPersonalDoc(label: unknown): boolean {
  const key = canonicalDocKey(label);
  return RULES.some((r) => r.personal && r.key === key);
}

/** Business identity for "same business": the legal name, ignoring case, spaces and punctuation. */
export function businessKey(name: unknown): string {
  const k = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return k === "untitledapplication" ? "" : k;
}
