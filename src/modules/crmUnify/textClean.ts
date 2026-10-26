// BF_SERVER_v856_CRM_UNIFY - pure text rules for the "Clean up data" tool. Nothing here touches the database; the
// tool only PROPOSES these changes and staff choose which to apply.

const LOWER_PARTICLES = new Set(["de", "da", "del", "della", "der", "di", "du", "la", "le", "van", "von", "den", "dos", "das", "y", "e"]);
// Real surnames that start with "Mac" but are not Mac + capital.
const MAC_EXCEPTIONS = new Set([
  "mack", "macey", "macy", "machado", "macias", "mackie", "mackey", "macon", "macha", "machin", "machen", "mace",
  "macedo", "macero", "macek", "machida", "macho", "macklin", "mackin", "macri", "macario", "macau", "maccabee",
]);

function hasLetters(s: string): boolean {
  return /[a-z]/i.test(s);
}

/** True when every letter is upper case (JOHN SMITH) or every letter is lower case (john smith). */
export function isAllCapsOrLower(s: string): boolean {
  const letters = s.replace(/[^a-z]/gi, "");
  if (letters.length < 2) return false;
  return letters === letters.toUpperCase() || letters === letters.toLowerCase();
}

function capWord(word: string): string {
  if (!word) return word;
  const lower = word.toLowerCase();
  // O'Brien, D'Angelo
  const apos = /^([a-z])'([a-z].*)$/.exec(lower);
  if (apos) return apos[1]!.toUpperCase() + "'" + capWord(apos[2]!);
  // McDonald
  if (/^mc[a-z]{2,}$/.test(lower)) return "Mc" + lower.charAt(2).toUpperCase() + lower.slice(3);
  // MacDonald (but not Mack, Macy, Machado...)
  if (/^mac[a-z]{3,}$/.test(lower) && !MAC_EXCEPTIONS.has(lower)) return "Mac" + lower.charAt(3).toUpperCase() + lower.slice(4);
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** "JOHN O'BRIEN-MCDONALD" -> "John O'Brien-McDonald"; "mary van der berg" -> "Mary van der Berg". */
export function properCasePersonName(input: string): string {
  const s = collapseSpaces(input);
  return s
    .split(" ")
    .map((token, i) => {
      if (i > 0 && LOWER_PARTICLES.has(token.toLowerCase())) return token.toLowerCase();
      return token.split("-").map(capWord).join("-");
    })
    .join(" ");
}

const COMPANY_SUFFIX: Record<string, string> = {
  llc: "LLC", "l.l.c": "LLC", "l.l.c.": "LLC", inc: "Inc.", "inc.": "Inc.", ltd: "Ltd.", "ltd.": "Ltd.",
  corp: "Corp.", "corp.": "Corp.", co: "Co.", "co.": "Co.", llp: "LLP", lp: "LP", plc: "PLC", ulc: "ULC",
  pllc: "PLLC", "p.c.": "P.C.", pc: "PC", gmbh: "GmbH", ltee: "Ltee", "s.a.": "S.A.",
};
const COMPANY_LOWER = new Set(["and", "of", "the", "for", "in", "on", "at", "by", "to"]);

function companyWord(word: string, index: number, wasAllCaps: boolean): string {
  const key = word.toLowerCase();
  if (index > 0 && COMPANY_SUFFIX[key]) return COMPANY_SUFFIX[key]!;
  if (index > 0 && COMPANY_LOWER.has(key)) return key;
  if (word === "&") return word;
  // Short all-consonant words in an all-caps name are acronyms: "BIBUSA CN LLC" keeps "CN".
  if (wasAllCaps && /^[a-z]{2,4}$/i.test(word) && !/[aeiouy]/i.test(word)) return word.toUpperCase();
  return word.split("-").map(capWord).join("-");
}

/** "POKE PROD LLC" -> "Poke Prod LLC", "acme widgets inc" -> "Acme Widgets Inc.", "BIBUSA CN LLC" -> "Bibusa CN LLC". */
export function properCaseCompanyName(input: string): string {
  const s = collapseSpaces(input);
  const letters = s.replace(/[^a-z]/gi, "");
  const wasAllCaps = letters.length > 0 && letters === letters.toUpperCase();
  return s.split(" ").map((w, i) => companyWord(w, i, wasAllCaps)).join(" ");
}

export function collapseSpaces(s: string): string {
  return String(s ?? "").replace(/[\u00a0\s]+/g, " ").trim();
}

/** Digits to E.164: 10 digits -> +1XXXXXXXXXX, 11 starting 1 -> +1..., an explicit +country stays. Else null. */
export function toE164(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) {
    if (digits.length >= 8 && digits.length <= 15) return "+" + digits;
    return null;
  }
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return null;
}

/** +14035550123 -> (403) 555-0123; other countries are left as stored. */
export function formatPhoneDisplay(input: unknown): string {
  const e164 = toE164(input);
  if (!e164) return String(input ?? "");
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function cleanEmail(input: unknown): string {
  return String(input ?? "").replace(/\s+/g, "").toLowerCase();
}

export const PLACEHOLDER_NAME_RE = /^\s*(unknown|new applicant|applicant)?\s*\(?\s*application started\s*\)?\s*$|^\s*unknown\s*$/i;

export type Proposal = { field: string; before: string; after: string; reason: string };

/** Proposed changes for one contact. `knownName` is a real name found on its application, if any. */
export function proposeContactFixes(row: Record<string, unknown>, knownName?: { first?: string | null; last?: string | null } | null): Proposal[] {
  const out: Proposal[] = [];
  const str = (k: string) => (row[k] == null ? "" : String(row[k]));
  const nameLike = (field: string) => {
    const v = str(field);
    if (!v || !hasLetters(v)) return;
    if (PLACEHOLDER_NAME_RE.test(v)) return;
    let next = collapseSpaces(v);
    let reason = next !== v ? "Extra spaces" : "";
    if (isAllCapsOrLower(next)) {
      const cased = properCasePersonName(next);
      if (cased !== next) { next = cased; reason = v === v.toUpperCase() ? "All capitals" : "All lower case"; }
    }
    if (next !== v) out.push({ field, before: v, after: next, reason: reason || "Name format" });
  };
  nameLike("first_name");
  nameLike("last_name");
  const name = str("name");
  if (name && PLACEHOLDER_NAME_RE.test(name)) {
    const first = collapseSpaces(String(knownName?.first ?? row.first_name ?? ""));
    const last = collapseSpaces(String(knownName?.last ?? row.last_name ?? ""));
    const real = [first, last].filter((p) => p && !/^unknown$/i.test(p)).join(" ");
    if (real) out.push({ field: "name", before: name, after: isAllCapsOrLower(real) ? properCasePersonName(real) : real, reason: "Placeholder name - real name known" });
  } else {
    nameLike("name");
  }
  for (const field of ["email", "secondary_email"]) {
    const v = str(field);
    if (!v) continue;
    const next = cleanEmail(v);
    if (next !== v) out.push({ field, before: v, after: next, reason: /\s/.test(v) ? "Spaces in email" : "Capitals in email" });
  }
  for (const field of ["phone", "secondary_phone"]) {
    const v = str(field);
    if (!v) continue;
    const next = toE164(v);
    if (next && next !== v) out.push({ field, before: v, after: next, reason: "Phone format (stored as +1XXXXXXXXXX)" });
  }
  const title = str("job_title");
  if (title && collapseSpaces(title) !== title) out.push({ field: "job_title", before: title, after: collapseSpaces(title), reason: "Extra spaces" });
  return out;
}

export function proposeCompanyFixes(row: Record<string, unknown>): Proposal[] {
  const out: Proposal[] = [];
  const str = (k: string) => (row[k] == null ? "" : String(row[k]));
  for (const field of ["name", "legal_name", "dba_name"]) {
    const v = str(field);
    if (!v || !hasLetters(v)) continue;
    let next = collapseSpaces(v);
    let reason = next !== v ? "Extra spaces" : "";
    if (isAllCapsOrLower(next)) {
      const cased = properCaseCompanyName(next);
      if (cased !== next) { next = cased; reason = v === v.toUpperCase() ? "All capitals" : "All lower case"; }
    }
    if (next !== v) out.push({ field, before: v, after: next, reason: reason || "Name format" });
  }
  const email = str("email");
  if (email && cleanEmail(email) !== email) out.push({ field: "email", before: email, after: cleanEmail(email), reason: "Capitals or spaces in email" });
  const phone = str("phone");
  const e164 = phone ? toE164(phone) : null;
  if (phone && e164 && e164 !== phone) out.push({ field: "phone", before: phone, after: e164, reason: "Phone format (stored as +1XXXXXXXXXX)" });
  for (const field of ["website", "domain", "industry", "address_city", "city"]) {
    const v = str(field);
    if (v && collapseSpaces(v) !== v) out.push({ field, before: v, after: collapseSpaces(v), reason: "Extra spaces" });
  }
  return out;
}
