// BF_SERVER_BLOCK_v494_LENDER_EMAIL_BOUNCES - recognise a bounce notice (NDR) and
// read why it bounced and which address failed. Pure functions; the worker does I/O.
export type BounceReason = "bad_address" | "mailbox_full" | "too_large" | "blocked" | "rejected";

const NDR_SUBJECT = /^(undeliverable|undelivered mail|delivery status notification \((failure|delay)\)|mail delivery (failed|subsystem)|returned mail|delivery has failed|failure notice|message not delivered)/i;
const NDR_SENDER = /(postmaster|mailer-daemon|microsoftexchange|mail delivery (subsystem|system))/i;

export function isBounce(subject: string | null | undefined, fromAddress: string | null | undefined, fromName?: string | null): boolean {
  const subj = String(subject ?? "").trim();
  if (NDR_SUBJECT.test(subj)) return true;
  return NDR_SENDER.test(`${fromAddress ?? ""} ${fromName ?? ""}`) && /deliver|undeliver|returned|fail/i.test(subj);
}

export function bounceReason(text: string): BounceReason {
  const t = text.toLowerCase();
  if (/(mailbox (is )?full|quota|over (the )?limit|insufficient (system )?storage|5\.2\.2|4\.2\.2)/.test(t)) return "mailbox_full";
  if (/(does ?n[o']?t exist|couldn't be found|could not be found|no such user|user unknown|unknown user|recipient not found|address rejected|invalid (recipient|address|mailbox)|mailbox unavailable|5\.1\.1|5\.1\.10|5\.4\.1|recipient address rejected)/.test(t)) return "bad_address";
  if (/(too large|size limit|exceeds the maximum|message size|5\.3\.4|5\.2\.3)/.test(t)) return "too_large";
  if (/(blocked|spam|policy|blacklist|block list|5\.7\.\d)/.test(t)) return "blocked";
  return "rejected";
}

export const BOUNCE_LABEL: Record<BounceReason, string> = {
  bad_address: "address does not exist",
  mailbox_full: "mailbox full",
  too_large: "message too large",
  blocked: "blocked by the lender's mail server",
  rejected: "rejected by the lender's mail server",
};

/** Email addresses in the notice that are not our own (the failed recipients). */
export function failedRecipients(text: string, ownAddresses: string[]): string[] {
  const own = new Set(ownAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean));
  const ownDomains = new Set([...own].map((a) => a.split("@")[1]).filter(Boolean));
  const found = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const a = m[0].toLowerCase().replace(/\.+$/, "");
    const domain = a.split("@")[1] ?? "";
    if (own.has(a) || ownDomains.has(domain)) continue;
    if (/^(postmaster|mailer-daemon|noreply|no-reply)@/.test(a) || /outlook\.com$|protection\.outlook\.com$/.test(domain) && /^(postmaster|microsoftexchange)/.test(a)) continue;
    found.add(a);
  }
  return [...found];
}
