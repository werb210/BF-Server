// BF_SERVER_CONTACT_FORM_SPAM_v1 - Todd 2026-11-27: a bot sent the website contact form as "PAUL WILLIAMS / SFCSS" with
// a throwaway Microsoft address (<GUID>@ssfc01.onmicrosoft.com). The form took any text as an email, made a CRM contact
// and company, emailed the bot our welcome template and texted every staff member. Now:
//   - an email that is not an email is refused (the person sees the error and can fix it);
//   - an obvious bot (a GUID mailbox, a filled hidden "website" field) gets the normal thank-you reply but nothing is
//     created, sent or notified, so bots learn nothing.
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isEmailAddress(email: unknown): boolean {
  const s = String(email ?? "").trim();
  return s.length <= 254 && EMAIL_RE.test(s);
}

/** Why this submission looks like a bot, or null for a person. */
export function botReason(body: Record<string, unknown>): string | null {
  const email = String(body.email ?? "").trim();
  const local = email.split("@")[0] ?? "";
  if (GUID_RE.test(local)) return "guid_mailbox";
  const trap = body.website ?? body.company_website ?? body.hp;
  if (typeof trap === "string" && trap.trim()) return "honeypot";
  return null;
}
