// BF_SERVER_v846_FRAUD - throwaway (disposable) email services and the big free mail providers. The disposable list
// covers the services seen most often; FRAUD_EXTRA_DISPOSABLE_DOMAINS (comma separated) adds more without a deploy.
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "10minutemail.com", "10minutemail.net", "20minutemail.com", "33mail.com", "anonaddy.me", "burnermail.io", "byom.de",
  "dispostable.com", "dropmail.me", "emailondeck.com", "fakeinbox.com", "fakemail.net", "getairmail.com", "getnada.com",
  "guerrillamail.biz", "guerrillamail.com", "guerrillamail.de", "guerrillamail.info", "guerrillamail.net", "guerrillamail.org",
  "guerrillamailblock.com", "harakirimail.com", "inboxbear.com", "incognitomail.org", "jetable.org", "luxusmail.org",
  "mail-temp.com", "mail.tm", "mailcatch.com", "maildrop.cc", "mailinator.com", "mailinator.net", "mailinator2.com",
  "mailnesia.com", "mailpoof.com", "mailsac.com", "mintemail.com", "moakt.com", "mohmal.com", "mytemp.email", "nada.email",
  "nwytg.net", "owlymail.com", "sharklasers.com", "spam4.me", "spamgourmet.com", "spambox.us", "tempail.com", "temp-mail.io",
  "temp-mail.org", "tempinbox.com", "tempmail.com", "tempmail.dev", "tempmail.net", "tempmailo.com", "tempr.email",
  "throwawaymail.com", "tmail.ws", "tmpmail.net", "tmpmail.org", "trashmail.com", "trashmail.de", "trashmail.net",
  "yopmail.com", "yopmail.fr", "yopmail.net", "zetmail.com", "emailfake.com", "fakemailgenerator.com", "inboxkitten.com",
  "mailforspam.com", "spamdecoy.net", "discard.email", "discardmail.com", "einrot.com", "armyspy.com", "cuvox.de",
  "dayrep.com", "fleckens.hu", "gustr.com", "jourrapide.com", "rhyta.com", "superrito.com", "teleworm.us", "grr.la",
  "pokemail.net", "spamex.com", "tempmailaddress.com", "temporarymail.com", "minuteinbox.com", "emltmp.com", "cmail.club",
  "vomoto.com", "chacuo.net", "linshiyouxiang.net", "tmails.net", "1secmail.com", "1secmail.net", "1secmail.org",
  "esiix.com", "wwjmp.com", "xojxe.com", "yoggm.com", "kzccv.com", "qiott.com", "laafd.com", "txcct.com", "rteet.com",
]);

export const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.ca", "live.com", "live.ca", "msn.com", "yahoo.com",
  "yahoo.ca", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "protonmail.com", "proton.me", "pm.me", "gmx.com",
  "gmx.net", "mail.com", "shaw.ca", "telus.net", "rogers.com", "sympatico.ca", "bell.net", "videotron.ca", "cogeco.ca",
  "eastlink.ca", "sasktel.net", "comcast.net", "att.net", "verizon.net", "zoho.com", "fastmail.com", "hey.com", "tutanota.com",
]);

export function isDisposableDomain(domain: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const d = domain.toLowerCase();
  if (DISPOSABLE_DOMAINS.has(d)) return true;
  const extra = String(env.FRAUD_EXTRA_DISPOSABLE_DOMAINS ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return extra.includes(d);
}
