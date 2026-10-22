// BF_SERVER_v846_FRAUD - check 9 (device and location) and check 10 (behaviour in the application wizard).
// The client app sends a random device id it keeps (not a fingerprint of the hardware) and a few counts; the server
// adds the IP address it saw. Device id, IP and answers are stored only as keyed hashes.
import { notApplicable, notConfigured, combine, result, type CheckResult, type Reason } from "../types.js";

export type DeviceRow = {
  device_hash: string | null; ip_hash: string | null; ip_country: string | null; ip_region: string | null;
  asn: string | null; asn_org: string | null; ip_flags: Record<string, unknown> | null; ip_provider: string | null;
  behaviour: Record<string, unknown> | null; answers_hash: string | null;
};

const PROVINCES: Record<string, string> = {
  ab: "alberta", bc: "british columbia", mb: "manitoba", nb: "new brunswick", nl: "newfoundland and labrador", ns: "nova scotia",
  nt: "northwest territories", nu: "nunavut", on: "ontario", pe: "prince edward island", qc: "quebec", sk: "saskatchewan", yt: "yukon",
};

export function sameRegion(a: string | null, b: string | null): boolean | null {
  const n = (s: string | null) => { const v = String(s ?? "").toLowerCase().trim(); return PROVINCES[v] ?? v; };
  const x = n(a), y = n(b);
  if (!x || !y) return null;
  return x === y || x.includes(y) || y.includes(x);
}

export function evaluateDevice(i: {
  row: DeviceRow | null;
  otherBusinessesSameDevice: number;
  otherBusinessesSameIp: number;
  licenseeCountry: string | null;
  businessProvince: string | null;
  ipConfigured: boolean;
}): CheckResult {
  if (!i.row) return notApplicable("No device information was received (the application was not completed in the client app, or was entered by staff).");
  const r = i.row;
  const reasons: Reason[] = [];
  if (i.otherBusinessesSameDevice >= 2) reasons.push({ code: "device_many_businesses", severity: "red", text: `The same device was used to apply for ${i.otherBusinessesSameDevice} other businesses.` });
  else if (i.otherBusinessesSameDevice === 1) reasons.push({ code: "device_other_business", severity: "amber", text: "The same device was used to apply for one other business (a bookkeeper or partner can explain this)." });
  if (i.otherBusinessesSameIp >= 3) reasons.push({ code: "ip_many_businesses", severity: "amber", text: `The same internet connection was used by applications for ${i.otherBusinessesSameIp} other businesses.` });
  const flags = r.ip_flags ?? {};
  if (flags.tor === true) reasons.push({ code: "ip_tor", severity: "red", text: "The application came through the Tor anonymity network." });
  else if (flags.vpn === true || flags.proxy === true) reasons.push({ code: "ip_vpn", severity: "amber", text: "The application came through a VPN or proxy, which hides where the applicant really is." });
  else if (flags.hosting === true) reasons.push({ code: "ip_hosting", severity: "amber", text: `The application came from a data-centre network${r.asn_org ? ` (${r.asn_org})` : ""}, not a home or business connection.` });
  // BF_SERVER_v846_FRAUD - licenseeCountry may list several countries ("CA,US").
  const home = String(i.licenseeCountry ?? "").toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  if (r.ip_country && home.length && !home.includes(r.ip_country.toUpperCase())) {
    reasons.push({ code: "ip_out_of_country", severity: "amber", text: `The application was made from ${r.ip_country}, outside the country you lend in.` });
  } else if (r.ip_region && i.businessProvince && sameRegion(r.ip_region, i.businessProvince) === false) {
    reasons.push({ code: "ip_out_of_region", severity: "info", text: `The application was made from ${r.ip_region}, but the business is in ${i.businessProvince}.` });
  }
  if (!reasons.length) reasons.push({ code: "device_ok", severity: "info", text: "The device and connection have not been used for any other business, and no VPN was seen." });
  const own = result(reasons, { other_businesses_same_device: i.otherBusinessesSameDevice, other_businesses_same_ip: i.otherBusinessesSameIp, ip_country: r.ip_country });
  return i.ipConfigured ? own : combine([own, notConfigured("IP location and VPN detection is not set up (IPINFO_TOKEN); device sharing is still checked.", "ipinfo")]);
}

/** Sensitive fields: any paste into one of these is counted (the content is never sent). Matched on name TOKENS
 *  (split on _ . - and camelCase) so "business_name" is not mistaken for "sin" and "accountNumber" still counts. */
const SENSITIVE_TOKENS = new Set(["sin", "ssn", "dob", "birth", "birthdate", "bank", "account", "acct", "transit", "institution", "routing", "iban", "bn", "email", "phone", "mobile", "cell", "card", "password"]);

export function isSensitiveField(name: string): boolean {
  const tokens = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((t) => SENSITIVE_TOKENS.has(t)) || /businessnumber|dateofbirth|socialinsurance|accountnumber/.test(tokens.join(""));
}

export function evaluateBehaviour(i: { row: DeviceRow | null; sameAnswersOtherBusinesses: number }): CheckResult {
  const b = (i.row?.behaviour ?? null) as Record<string, any> | null;
  if (!i.row || !b || !Object.keys(b).length) return notApplicable("No application behaviour was received from the client app.");
  const reasons: Reason[] = [];
  const pasted: string[] = Array.isArray(b.pasted_fields) ? b.pasted_fields.filter((f: unknown) => typeof f === "string") : [];
  const sensitivePasted = pasted.filter(isSensitiveField);
  const secs = Number(b.completion_seconds);
  const fields = Number(b.fields_completed ?? 0);
  if (sensitivePasted.length >= 3) reasons.push({ code: "paste_sensitive", severity: "amber", text: `Sensitive details were pasted rather than typed (${sensitivePasted.slice(0, 4).join(", ")}) - typical when working from someone else's information.` });
  else if (sensitivePasted.length) reasons.push({ code: "paste_some", severity: "info", text: `${sensitivePasted.length} sensitive field(s) were pasted (${sensitivePasted.join(", ")}).` });
  if (Number.isFinite(secs) && secs > 0 && fields >= 15) {
    const perField = secs / fields;
    if (perField < 1.5) reasons.push({ code: "too_fast", severity: "red", text: `The ${fields}-field application was completed in ${Math.round(secs)} seconds - faster than a person can type it.` });
    else if (perField < 3) reasons.push({ code: "fast", severity: "amber", text: `The application was completed unusually fast (${Math.round(secs)} seconds for ${fields} fields).` });
  }
  if (b.autofill_used === true) reasons.push({ code: "autofill", severity: "info", text: "The browser's autofill was used (normal for returning users)." });
  if (i.sameAnswersOtherBusinesses > 0) reasons.push({ code: "same_answers", severity: "red", text: `The answers are identical to an application for ${i.sameAnswersOtherBusinesses} other business(es).` });
  if (!reasons.length) reasons.push({ code: "behaviour_ok", severity: "info", text: "The application was filled in at a normal pace, without pasted sensitive details." });
  return result(reasons, { pasted_sensitive: sensitivePasted.length, completion_seconds: Number.isFinite(secs) ? Math.round(secs) : null });
}
