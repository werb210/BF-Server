// BF_SERVER_v846_FRAUD - the smaller outside lookups: domain age (RDAP), phone line type (Twilio Lookup), IP address
// intelligence (ipinfo.io), ID verification and voice analysis vendors, and street-address classification.
// Each one says when it is not set up; none of them ever makes up an answer.
import { defaultFetch, networkAllowed, requestJson, type FetchLike } from "./http.js";

// ---------------------------------------------------------------- domain age (RDAP, public, no key)
export type DomainAge = { ok: true; registered: string | null; ageDays: number | null } | { ok: false; error: string };

export interface DomainAgeProvider { readonly name: string; configured(): boolean; age(domain: string): Promise<DomainAge> }

export function rdapRegistered(body: any): string | null {
  const ev: any[] = Array.isArray(body?.events) ? body.events : [];
  const reg = ev.find((e) => /registration/i.test(String(e?.eventAction ?? "")));
  const d = reg?.eventDate ? new Date(reg.eventDate) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

/** RDAP via rdap.org (redirects to the registry for the domain's TLD). FRAUD_RDAP=off turns it off. */
export function rdapProvider(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike, now: () => Date = () => new Date()): DomainAgeProvider {
  const f = fetchImpl ?? defaultFetch();
  const base = String(env.FRAUD_RDAP_URL ?? "https://rdap.org").replace(/\/+$/, "");
  return {
    name: "rdap",
    configured: () => String(env.FRAUD_RDAP ?? "on").toLowerCase() !== "off" && networkAllowed(fetchImpl, env),
    async age(domain: string): Promise<DomainAge> {
      const r = await requestJson(f, `${base}/domain/${encodeURIComponent(domain)}`, { headers: { Accept: "application/rdap+json" } });
      if (!r.ok) return { ok: false, error: r.error };
      const registered = rdapRegistered(r.body);
      return { ok: true, registered, ageDays: registered ? Math.floor((now().getTime() - new Date(registered).getTime()) / 86_400_000) : null };
    },
  };
}

// ---------------------------------------------------------------- phone line type (Twilio Lookup v2)
export type LineType = { ok: true; type: string | null; carrier: string | null; valid: boolean } | { ok: false; error: string };

export interface LineTypeProvider { readonly name: string; configured(): boolean; lookup(e164: string): Promise<LineType> }

export function twilioLineTypeProvider(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): LineTypeProvider {
  const sid = String(env.TWILIO_ACCOUNT_SID ?? "").trim();
  const token = String(env.TWILIO_AUTH_TOKEN ?? "").trim();
  const f = fetchImpl ?? defaultFetch();
  return {
    name: "twilio_lookup",
    configured: () => Boolean(sid && token) && String(env.TWILIO_LOOKUP_LINE_TYPE ?? "on").toLowerCase() !== "off" && networkAllowed(fetchImpl, env),
    async lookup(e164: string): Promise<LineType> {
      const r = await requestJson(f, `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`, {
        headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") },
      });
      if (!r.ok) return { ok: false, error: r.error };
      const lti = r.body?.line_type_intelligence ?? {};
      return { ok: true, valid: r.body?.valid !== false, type: lti.type ? String(lti.type) : null, carrier: lti.carrier_name ? String(lti.carrier_name) : null };
    },
  };
}

// ---------------------------------------------------------------- IP intelligence (ipinfo.io)
export type IpIntel = {
  ok: true; country: string | null; region: string | null; asn: string | null; asnOrg: string | null;
  vpn: boolean | null; proxy: boolean | null; hosting: boolean | null; tor: boolean | null;
} | { ok: false; error: string };

export interface IpIntelProvider { readonly name: string; configured(): boolean; lookup(ip: string): Promise<IpIntel> }

/** Data-centre / cloud networks: a person applying from one of these is almost always behind a VPN or proxy. */
export const HOSTING_ORGS = /amazon|aws|google cloud|google llc|microsoft|azure|digitalocean|ovh|hetzner|linode|akamai|vultr|choopa|leaseweb|contabo|m247|datacamp|cdn77|oracle|alibaba|tencent|scaleway|hostinger|ionos|godaddy|cloudflare|packethub|tzulo|quadranet|psychz|nforce|worldstream|zenlayer/i;

export function parseIpinfo(body: any): Extract<IpIntel, { ok: true }> {
  const org = String(body?.org ?? body?.asn?.name ?? "");
  const asnM = org.match(/^(AS\d+)\s+(.*)$/);
  const privacy = body?.privacy && typeof body.privacy === "object" ? body.privacy : null;
  const asnType = String(body?.asn?.type ?? "");
  return {
    ok: true,
    country: body?.country ? String(body.country) : null,
    region: body?.region ? String(body.region) : null,
    asn: asnM ? asnM[1]! : body?.asn?.asn ? String(body.asn.asn) : null,
    asnOrg: asnM ? asnM[2]! : org || null,
    vpn: privacy ? Boolean(privacy.vpn) : null,
    proxy: privacy ? Boolean(privacy.proxy) : null,
    tor: privacy ? Boolean(privacy.tor) : null,
    hosting: privacy ? Boolean(privacy.hosting) : asnType ? asnType === "hosting" : HOSTING_ORGS.test(org) ? true : null,
  };
}

/** IPINFO_TOKEN set -> ipinfo.io. The free plan gives country, region and network; VPN/proxy flags need its privacy add-on. */
export function ipinfoProvider(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): IpIntelProvider {
  const token = String(env.IPINFO_TOKEN ?? "").trim();
  const f = fetchImpl ?? defaultFetch();
  return {
    name: "ipinfo",
    configured: () => Boolean(token) && networkAllowed(fetchImpl, env),
    async lookup(ip: string): Promise<IpIntel> {
      const r = await requestJson(f, `https://ipinfo.io/${encodeURIComponent(ip)}/json`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return { ok: false, error: r.error };
      return parseIpinfo(r.body);
    },
  };
}

// ---------------------------------------------------------------- ID verification vendor (pluggable)
export type IdvResult = { ok: true; verdict: "pass" | "fail" | "review"; reasons: string[] } | { ok: false; error: string };

export interface IdvProvider { readonly name: string; configured(): boolean; verify(input: { documentId: string; image: Buffer; name: string | null; dob: string | null }): Promise<IdvResult> }

/** No vendor is wired in yet. Set FRAUD_IDV_PROVIDER once one is added; until then the check says "not set up". */
export function idvProvider(env: NodeJS.ProcessEnv = process.env): IdvProvider {
  const chosen = String(env.FRAUD_IDV_PROVIDER ?? "").trim();
  return {
    name: chosen || "none",
    configured: () => false,
    async verify() { return { ok: false, error: chosen ? `unknown_idv_provider_${chosen}` : "not_configured" }; },
  };
}

// ---------------------------------------------------------------- call voice analysis (pluggable)
export type VoiceResult = { ok: true; synthetic_probability: number; verdict: "likely_human" | "uncertain" | "likely_synthetic" } | { ok: false; error: string };

export interface VoiceProvider { readonly name: string; configured(): boolean; analyze(input: { recordingId: string; url: string }): Promise<VoiceResult> }

/** No voice / deepfake vendor is wired in yet: every recording reports "not configured", never a made-up verdict. */
export function voiceProvider(env: NodeJS.ProcessEnv = process.env): VoiceProvider {
  const chosen = String(env.FRAUD_VOICE_PROVIDER ?? "").trim();
  return {
    name: chosen || "none",
    configured: () => false,
    async analyze() { return { ok: false, error: chosen ? `unknown_voice_provider_${chosen}` : "not_configured" }; },
  };
}

// ---------------------------------------------------------------- street address type
export type AddressType = { kind: "virtual_office" | "mail_drop" | "po_box" | "street" | "unknown"; matched: string | null; source: string };

export interface AddressProvider { readonly name: string; configured(): boolean; classify(address: string): Promise<AddressType | null> }

/** Virtual-office and mail-drop operators whose name often appears in the address itself. */
export const VIRTUAL_OFFICE_NAMES = ["regus", "spaces", "wework", "davinci", "servcorp", "industrious", "iwg", "hq global", "intelligent office", "premier business centres", "office evolution", "opus virtual", "anytime mailbox", "ipostal", "earth class mail", "virtual post mail", "traveling mailbox", "postscan mail"];
export const MAIL_DROP_NAMES = ["ups store", "the ups store", "mail boxes etc", "mailboxes etc", "postnet", "postal outlet", "pak mail", "fedex office", "box 'n' ship", "kwik kopy"];

/** Built-in list: PO boxes, private mailboxes and well-known virtual-office / mail-drop operators named in the address. */
export function classifyAddressByList(address: string): AddressType {
  const a = ` ${address.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ")} `;
  if (/\b(p ?o ?box|post office box|box \d+|case postale|cp \d+)\b/.test(a)) return { kind: "po_box", matched: "PO box", source: "list" };
  if (/\b(pmb|private mailbox|mailbox)\s*#?\s*\d+/.test(a)) return { kind: "mail_drop", matched: "private mailbox", source: "list" };
  const mail = MAIL_DROP_NAMES.find((n) => a.includes(` ${n} `));
  if (mail) return { kind: "mail_drop", matched: mail, source: "list" };
  const virt = VIRTUAL_OFFICE_NAMES.find((n) => a.includes(` ${n} `));
  if (virt) return { kind: "virtual_office", matched: virt, source: "list" };
  return { kind: "unknown", matched: null, source: "list" };
}

/** A paid address-verification service (Canada Post AddressComplete, Smarty) plugs in here; none is wired in yet. */
export function addressProvider(env: NodeJS.ProcessEnv = process.env): AddressProvider {
  const chosen = String(env.FRAUD_ADDRESS_PROVIDER ?? "").trim();
  return { name: chosen || "none", configured: () => false, async classify() { return null; } };
}
