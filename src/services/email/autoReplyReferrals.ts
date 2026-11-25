// BF_SERVER_AUTO_REPLY_REFERRALS_v1 - an out-of-office or "I have left" auto-reply often names who to contact instead
// ("please contact Tyler Wright at Tyler.Wright@shoreunitedbank.com"). This reads those people out of the reply so the
// email flow can add them, and says whether the sender has left the company. Only addresses at the sender's own company
// (same domain) are taken; nothing else from the message leaves this server.
export type Referral = { email: string; name: string | null; phone: string | null };
export type AutoReplyInfo = { autoReply: boolean; left: boolean; referrals: Referral[] };

const AUTO_SUBJECT = /^\s*(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|ooo\b|autoreply|away from (the )?office|réponse automatique)/i;
const LEFT = /\b(no longer (with|employed|at|working)|(have|has) (retired|left)|transitioned into retirement|last day (of employment )?(with|at|is|was)|is retired|left the (company|bank|firm))\b/i;
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const GENERIC = /^(no-?reply|do-?not-?reply|postmaster|mailer-daemon|unsubscribe|privacy|compliance|webmaster)@/i;
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

const domainOf = (e: string) => e.split("@")[1]?.toLowerCase() ?? "";
const sameCompany = (a: string, b: string) => {
  const x = domainOf(a), y = domainOf(b);
  return !!x && !!y && (x === y || x.endsWith("." + y) || y.endsWith("." + x));
};

/** A person's name written just before their address ("contact Tyler Wright at tyler@..." / "Emily Schroeder (emily@...)"). */
function nameBefore(text: string, at: number): string | null {
  const before = text.slice(Math.max(0, at - 80), at).replace(/\s+/g, " ");
  const m = /([A-Z][a-zA-Z'’-]+(?: [A-Z]\.)?(?: [A-Z][a-zA-Z'’-]+){1,2})\s*(?:at|@|:|-|–|\(|<)?\s*$/.exec(before);
  if (!m) return null;
  const name = m[1]!.trim();
  return /^(Please|Contact|For|Thank|Email|Office|Mobile|Phone|New|Minnesota|North|South|Dakota)\b/.test(name) ? null : name;
}

export function parseAutoReply(subject: string, body: string, from: string): AutoReplyInfo {
  const text = String(body ?? "").replace(/\r/g, "");
  const autoReply = AUTO_SUBJECT.test(String(subject ?? ""));
  if (!autoReply) return { autoReply: false, left: false, referrals: [] };
  // Stop before the sender's own signature block and legal footer where possible.
  const cut = text.search(/\n\s*(this (e-?mail|message) (and any|contains|is intended)|confidentiality notice|connect with us)/i);
  const main = cut > 0 ? text.slice(0, cut) : text;
  const seen = new Set<string>([String(from).toLowerCase()]);
  const referrals: Referral[] = [];
  for (const m of main.matchAll(EMAIL)) {
    const email = m[0].replace(/[.,;:)]+$/, "");
    const key = email.toLowerCase();
    if (seen.has(key) || GENERIC.test(key) || !sameCompany(key, from)) continue;
    seen.add(key);
    const after = main.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 30);
    const phone = PHONE.exec(after)?.[0]?.replace(/^[\s(]+/, "").trim() ?? null;
    referrals.push({ email: key, name: nameBefore(main, m.index ?? 0), phone });
    if (referrals.length >= 5) break;
  }
  return { autoReply: true, left: LEFT.test(main), referrals };
}
