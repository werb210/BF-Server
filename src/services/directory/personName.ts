// BF_SERVER_PERSON_NAMES_v1 (Todd, 2026-11-26: "those are titles, not names") - some lists put a job title ("Dir.",
// "Field Exmr.", "Senior Vice President"), a placeholder ("(general inbox)", "(name not found)") or "Name, Title" in the
// name column. A contact's name is only ever a person's name: a title moves to the title, a placeholder is dropped, and
// emails greet a contact with no person's name as "there", never "Hi Dir.".

const TITLE_WORDS = new Set(`
  pres president vice vp svp evp avp sr senior jr junior exec executive chief ceo cfo coo cco cto cro cmo cio ciso
  dir director directors mng mngr mgr manager managers managing mgmt management md gm head lead principal partner partners
  officer officers analyst analysts associate assoc asst assistant admin administrator administrative coordinator
  specialist consultant advisor adviser rep representative agent banker bankers lender lenders lending loan loans
  underwriter underwriting examiner exmr field credit commercial business small middle market markets sales national
  regional reg region branch district area territory southeast southwest northeast northwest east west north south
  central midwest special assets asset division dept department team desk group unit office services service support
  customer client clients relations relationship development new implementation cash treasury trade finance financial
  audit auditor international import export handling counsel legal compliance risk operations ops project training
  help general inbox info information contact contacts mailbox email abl mm cre sba equipment leasing portfolio
  servicing workout capital investment investments private wealth corporate institutional of and the for to in at
  mr mrs ms dr secretary treasurer controller founder owner
`.split(/\s+/).filter(Boolean));

const words = (s: string) => s.toLowerCase().replace(/[^a-z&\s-]/g, " ").split(/[\s&-]+/).filter(Boolean);

/** True when every word is a job-title word: "Dir.", "Field Exmr.", "Senior Vice President". */
export function isTitle(v: string): boolean {
  const w = words(v);
  return w.length > 0 && w.every((x) => TITLE_WORDS.has(x));
}

/** A placeholder or something that is not a name at all: "(general inbox)", an email or a web address. */
export function isPlaceholder(v: string): boolean {
  const s = v.trim();
  return !s || /^\(.*\)$/.test(s) || /@/.test(s) || /^(https?:\/\/|www\.)/i.test(s) || /\.(com|org|net|ca|bank)(\/|$)/i.test(s)
    || /^(unknown|n\/?a|none|tbd|name not found|no name)$/i.test(s);
}

/** The person's name and title from a list row's name and title columns. name is null when the row names no person. */
export function splitNameTitle(rawName: string | null | undefined, rawTitle: string | null | undefined): { name: string | null; title: string | null } {
  let name = String(rawName ?? "").replace(/\s+/g, " ").trim();
  let title = String(rawTitle ?? "").replace(/\s+/g, " ").trim() || null;
  if (isPlaceholder(name)) return { name: null, title };
  const comma = name.indexOf(",");
  if (comma > 0) {
    const head = name.slice(0, comma).trim();
    const tail = name.slice(comma + 1).trim();
    // "Susan Lamping, Vice President of Sales" -> name + title. ("Smith, John" stays as it is.)
    if (tail && isTitle(tail) && !isTitle(head)) { name = head; title = title ?? tail; }
  }
  if (isTitle(name)) return { name: null, title: title ?? name };
  return { name, title };
}

export const TITLE_WORD_LIST = [...TITLE_WORDS];
