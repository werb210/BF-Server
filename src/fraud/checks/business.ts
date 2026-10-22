// BF_SERVER_v846_FRAUD - check 6 (business reality) and check 7 (phone and email risk): pure evaluation of what the
// providers answered. Each sub-check that could not run says why; it never counts as a pass.
import type { RegistryLookup } from "../providers/registry.js";
import type { AddressType, DomainAge, LineType } from "../providers/lookups.js";
import { normName } from "../hash.js";
import { combine, notApplicable, notConfigured, result, type CheckResult, type Reason } from "../types.js";
import { isDisposableDomain, FREE_EMAIL_DOMAINS } from "./disposableDomains.js";

/** Do two personal names refer to the same person? Last name must match; first name or initial must match. */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const A = normName(a)?.split(" ").filter(Boolean) ?? [];
  const B = normName(b)?.split(" ").filter(Boolean) ?? [];
  if (A.length < 2 || B.length < 2) return false;
  const lastA = A[A.length - 1]!, lastB = B[B.length - 1]!;
  if (lastA !== lastB && !A.includes(lastB) && !B.includes(lastA)) return false;
  return A[0] === B[0] || A[0]![0] === B[0]![0];
}

export function registrySub(lookup: RegistryLookup | "not_configured" | "no_number", applicantNames: string[], businessName: string | null): CheckResult {
  if (lookup === "not_configured") return notConfigured("The corporate registry lookup is not set up (CORPORATIONS_CANADA_API_KEY).", "corporations_canada");
  if (lookup === "no_number") return notApplicable("No business or corporation number is on the file, so the federal registry could not be searched.");
  if ("error" in lookup) return { status: "error", reasons: [{ code: "registry_error", severity: "info", text: "The corporate registry could not be reached; the worker will try again." }], provider: "corporations_canada" };
  if (!lookup.found) {
    return lookup.reason === "no_number"
      ? notApplicable("The business number on the file is not in a format the registry accepts.")
      : result([{ code: "registry_not_found", severity: "amber", text: "The business number was not found in the federal corporate registry. It may be registered provincially only - confirm with a provincial search." }], undefined, "corporations_canada");
  }
  const reasons: Reason[] = [];
  if (lookup.active === false) reasons.push({ code: "registry_inactive", severity: "red", text: `The federal registry lists the corporation as "${lookup.status}".` });
  if (businessName && lookup.name) {
    const a = normName(businessName.replace(/\b(inc|ltd|ltee|corp|corporation|limited|incorporated)\b\.?/gi, "")) ?? "";
    const b = normName(lookup.name.replace(/\b(inc|ltd|ltee|corp|corporation|limited|incorporated)\b\.?/gi, "")) ?? "";
    if (a && b && !a.includes(b) && !b.includes(a)) reasons.push({ code: "registry_name_differs", severity: "amber", text: `The registered name is "${lookup.name}", not "${businessName}".` });
  }
  if (lookup.directors.length && applicantNames.length) {
    const match = applicantNames.some((n) => lookup.directors.some((d) => sameName(n, d)));
    if (!match) reasons.push({ code: "not_a_director", severity: "amber", text: `The applicant is not among the ${lookup.directors.length} director(s) listed in the registry.` });
  }
  if (!reasons.length) reasons.push({ code: "registry_ok", severity: "info", text: `The corporation is registered${lookup.status ? ` (${lookup.status})` : ""}${lookup.directors.length ? " and the applicant is a listed director" : ""}.` });
  return result(reasons, { registry_directors: lookup.directors.length }, "corporations_canada");
}

export function addressSub(addr: AddressType | null, hasAddress: boolean): CheckResult {
  if (!hasAddress) return notApplicable("No business address is on the file.");
  if (!addr || addr.kind === "unknown" || addr.kind === "street") {
    return result([{ code: "address_ok", severity: "info", text: "The business address is not a known PO box, mail drop or virtual office." }]);
  }
  const what = addr.kind === "po_box" ? "a PO box" : addr.kind === "mail_drop" ? `a mail-drop address${addr.matched ? ` (${addr.matched})` : ""}` : `a virtual office${addr.matched ? ` (${addr.matched})` : ""}`;
  return result([{ code: `address_${addr.kind}`, severity: "amber", text: `The business address is ${what}, not a place the business operates from.` }]);
}

export function domainAgeSub(label: "website" | "email domain", domain: string | null, age: DomainAge | "not_configured" | null): CheckResult {
  if (!domain) return notApplicable(`No ${label} is on the file.`);
  if (age === "not_configured") return notConfigured("Domain age lookups are turned off (FRAUD_RDAP).", "rdap");
  if (!age || !age.ok) return { status: "error", reasons: [{ code: "rdap_error", severity: "info", text: `The age of ${domain} could not be looked up.` }], provider: "rdap" };
  if (age.ageDays == null) return result([{ code: "domain_age_unknown", severity: "info", text: `The registry for ${domain} does not publish its creation date.` }], undefined, "rdap");
  if (age.ageDays < 90) return result([{ code: "domain_new", severity: "amber", text: `The ${label} ${domain} was registered only ${age.ageDays} day(s) ago.` }], { domain_age_days: age.ageDays }, "rdap");
  if (age.ageDays < 365) return result([{ code: "domain_young", severity: "info", text: `The ${label} ${domain} is less than a year old.` }], { domain_age_days: age.ageDays }, "rdap");
  return result([{ code: "domain_established", severity: "info", text: `The ${label} ${domain} has been registered for ${Math.floor(age.ageDays / 365)} year(s).` }], { domain_age_days: age.ageDays }, "rdap");
}

const VOIP = new Set(["nonfixedvoip"]);
const RISKY_LINES = new Set(["nonfixedvoip", "premium", "sharedcost", "uan", "voicemail", "pager", "personal"]);

export function lineTypeSub(label: "business phone" | "applicant's phone", phone: string | null, lt: LineType | "not_configured" | null): CheckResult {
  if (!phone) return notApplicable(`No ${label} is on the file.`);
  if (lt === "not_configured") return notConfigured("Phone line-type lookups are not set up (Twilio credentials).", "twilio_lookup");
  if (!lt || !lt.ok) return { status: "error", reasons: [{ code: "lookup_error", severity: "info", text: `The ${label} could not be looked up.` }], provider: "twilio_lookup" };
  if (!lt.valid) return result([{ code: "phone_invalid", severity: "amber", text: `The ${label} is not a valid, working number.` }], undefined, "twilio_lookup");
  const t = String(lt.type ?? "").toLowerCase();
  if (VOIP.has(t)) return result([{ code: "phone_voip", severity: "amber", text: `The ${label} is an internet (VoIP) number${lt.carrier ? ` from ${lt.carrier}` : ""} - easy to create and throw away.` }], undefined, "twilio_lookup");
  if (RISKY_LINES.has(t)) return result([{ code: `phone_${t}`, severity: "amber", text: `The ${label} is a ${t} line, not a regular business or mobile number.` }], undefined, "twilio_lookup");
  if (/prepaid|pay as you go|tracfone|lucky mobile|public mobile|chatr/i.test(lt.carrier ?? "")) {
    return result([{ code: "phone_prepaid", severity: "amber", text: `The ${label} is on a prepaid carrier (${lt.carrier}).` }], undefined, "twilio_lookup");
  }
  return result([{ code: "phone_ok", severity: "info", text: `The ${label} is a ${t || "regular"} line${lt.carrier ? ` (${lt.carrier})` : ""}.` }], undefined, "twilio_lookup");
}

export function businessReality(parts: { registry: CheckResult; address: CheckResult; website: CheckResult; phone: CheckResult }): CheckResult {
  return combine([parts.registry, parts.address, parts.website, parts.phone]);
}

/** Does the email's local part look like the person (or business)? Generic inboxes are fine. */
export function emailMatchesName(email: string | null, first: string | null, last: string | null, business: string | null): boolean | null {
  const local = String(email ?? "").split("@")[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  if (!local) return null;
  if (/^(info|admin|office|contact|hello|accounts|accounting|sales|support|team|mail|ceo|owner|finance|billing)$/.test(local)) return true;
  const tokens = [first, last, ...(String(business ?? "").split(/\s+/))].map((t) => String(t ?? "").toLowerCase().replace(/[^a-z]/g, "")).filter((t) => t.length >= 3);
  if (!tokens.length) return null;
  if (tokens.some((t) => local.includes(t) || (t.length >= 5 && local.includes(t.slice(0, 5))))) return true;
  const fi = String(first ?? "").toLowerCase()[0], li = String(last ?? "").toLowerCase();
  if (fi && li && (local.startsWith(fi + li.slice(0, 3)) || local.startsWith(li.slice(0, 3) + fi))) return true;
  return false;
}

export function contactRisk(i: {
  email: string | null; domain: string | null; emailDomainAge: CheckResult; phone: CheckResult;
  nameMatch: boolean | null;
}): CheckResult {
  const reasons: Reason[] = [];
  if (!i.email) reasons.push({ code: "no_email", severity: "info", text: "No applicant email is on the file." });
  else if (i.domain && isDisposableDomain(i.domain)) reasons.push({ code: "email_disposable", severity: "red", text: `The email address uses ${i.domain}, a throwaway (disposable) email service.` });
  if (i.nameMatch === false) reasons.push({ code: "email_name_mismatch", severity: "info", text: "The email address does not resemble the applicant's or business's name (common, but worth a glance)." });
  const emailPart = result(reasons.length ? reasons : [{ code: "email_ok", severity: "info", text: "The email address is not from a disposable email service." }]);
  const parts = [emailPart, i.phone];
  if (i.domain && !FREE_EMAIL_DOMAINS.has(i.domain)) parts.push(i.emailDomainAge);
  return combine(parts);
}
