// BF_SERVER_MARKETING_SMS_v1 - bulk marketing SMS via Twilio, with per-recipient
// tracked links (signed token) so clicks drive the fallback cascade. Env-gated on
// a marketing from-number (TWILIO_SMS_FROM, e.g. the toll-free 800 once A2P-verified).
import jwt from "jsonwebtoken";
import { fetchTwilioClient } from "./twilio.js";
import { config } from "../config/index.js";
import { isUndeliverableNumber } from "../lib/smsDeliverability.js"; // BF_SERVER_GUARD_EVERYWHERE_v136

// BF_SERVER_SMS_CASCADE_COMPLETE_v12 - PUBLIC_SERVER_URL is not a setting that
// exists on the App Service; the deployed names are PUBLIC_BASE_URL and
// SERVER_URL. This only ever worked because of the hardcoded default, which
// would have been silently wrong the moment the host changed. Read the names
// that are actually configured, keeping the old one first for compatibility.
const PUBLIC_URL = (
  process.env.PUBLIC_SERVER_URL ||
  process.env.PUBLIC_BASE_URL ||
  process.env.SERVER_URL ||
  "https://server.boreal.financial"
).replace(/\/+$/, "");
const CASL_FOOTER = "Reply STOP to opt out. Info: www.boreal.financial/sms";
const INFO_ONLY_FOOTER = "Info: www.boreal.financial/sms";

// BF_SERVER_v935_SMS_PLAIN_SEGMENTS - one curly quote turns a whole text into UCS-2 (67 characters a segment instead
// of 153), so a 500-character text bills as 9 segments instead of 4. Typographic characters are swapped for plain
// ones before sending.
const PLAIN: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B\u2032\u00B4\u0060]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  [/[\u2013\u2014\u2015\u2212]/g, "-"],
  [/\u2026/g, "..."],
  [/[\u00A0\u2007\u202F\u2009\u200A\u2002\u2003]/g, " "],
  [/[\u200B\u200C\u200D\uFEFF]/g, ""],
  [/\u2022/g, "-"],
];
export function plainSmsText(text: string): string {
  let out = String(text ?? "");
  for (const [re, to] of PLAIN) out = out.replace(re, to);
  return out;
}

// GSM 03.38 basic set and its extension table (extension characters count as two).
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€\f";
export type SmsSegments = { encoding: "GSM-7" | "UCS-2"; characters: number; segments: number; nonGsm: string[] };
/** How Twilio will bill a text: GSM-7 is 160 per single / 153 per part, UCS-2 is 70 / 67. */
export function smsSegments(text: string): SmsSegments {
  const chars = Array.from(String(text ?? ""));
  const nonGsm = [...new Set(chars.filter((c) => !GSM_BASIC.includes(c) && !GSM_EXT.includes(c)))];
  if (nonGsm.length) {
    const units = chars.reduce((n, c) => n + (c.codePointAt(0)! > 0xffff ? 2 : 1), 0);
    return { encoding: "UCS-2", characters: units, segments: units <= 70 ? 1 : Math.ceil(units / 67), nonGsm };
  }
  const septets = chars.reduce((n, c) => n + (GSM_EXT.includes(c) ? 2 : 1), 0);
  return { encoding: "GSM-7", characters: septets, segments: septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153), nonGsm };
}
/** Rough price of one segment to a Canadian mobile (USD), carrier fees included. SMS_SEGMENT_PRICE_USD overrides. */
export function smsSegmentPrice(): number {
  const v = Number(process.env.SMS_SEGMENT_PRICE_USD);
  return Number.isFinite(v) && v > 0 ? v : 0.012;
}
/** The length of a short tracked link, for previews before any link exists. */
export const SHORT_LINK_SAMPLE = () => `${PUBLIC_URL}/api/r/s/AbCd2345`;

export function mergeSmsFields(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_match, key) => vars[String(key).toLowerCase()] ?? "");
}

/** Build the exact recipient-facing marketing SMS in one consistent order. */
export function renderMarketingSms(opts: { body: string; vars: Record<string, string>; link?: string | null }): string {
  const mergedBody = plainSmsText(mergeSmsFields(opts.body, opts.vars)).trim();
  // BF_SERVER_v935_SMS_PLAIN_SEGMENTS - the opt-out line is added once: a message that already says STOP keeps only
  // the Info link.
  const footer = /\bSTOP\b/.test(mergedBody) ? INFO_ONLY_FOOTER : CASL_FOOTER;
  return [mergedBody, opts.link?.trim(), footer].filter(Boolean).join(" ");
}

function fromNumber(): string {
  return String(process.env.TWILIO_SMS_FROM || config.twilio.number || config.twilio.phone || "");
}

// BF_SERVER_v806_NO_MARKETING_FROM_TOLL_FREE - the 866 toll-free number is verified with the carriers for
// application messages only (sign-in codes, status, documents, signing). Marketing texts from it would break
// that verification, so marketing SMS never goes out from a toll-free number: set TWILIO_SMS_FROM to a
// Canadian local number for campaigns and sequences.
const TOLL_FREE_AREA_CODES = new Set(["800", "833", "844", "855", "866", "877", "888"]);
export function isTollFreeNumber(n: unknown): boolean {
  let d = String(n ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length === 10 && TOLL_FREE_AREA_CODES.has(d.slice(0, 3));
}
// BF_SERVER_v808_TOLLFREE_MARKETING - marketing is to come from the 866. Allowed only once Twilio has approved
// marketing on the toll-free number (set TWILIO_TOLLFREE_MARKETING=on then), and only to people who ticked
// the optional "Text me offers" box (consent_source 'marketing_sms_optin'). Until then the v806 rule stands:
// no marketing from a toll-free number.
export function tollFreeMarketingApproved(): boolean {
  return String(process.env.TWILIO_TOLLFREE_MARKETING ?? "").trim().toLowerCase() === "on";
}
function marketingFromNumber(): string {
  const from = fromNumber();
  if (!from) return "";
  return !isTollFreeNumber(from) || tollFreeMarketingApproved() ? from : "";
}
export async function hasMarketingSmsOptIn(to: string): Promise<boolean> {
  const p10 = String(to ?? "").replace(/\D/g, "").slice(-10);
  if (p10.length !== 10) return false;
  try {
    const { pool } = await import("../db.js");
    const r = await pool.query(
      `SELECT 1 FROM contacts
        WHERE right(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = $1
          AND COALESCE(sms_consent, false) = true
          AND consent_source = 'marketing_sms_optin'
          AND COALESCE(sms_opt_out, false) = false
          AND COALESCE(marketing_opt_out, false) = false
        LIMIT 1`,
      [p10],
    );
    return (r.rows?.length ?? 0) > 0;
  } catch (err) {
    console.error("[marketingSms] opt-in check failed; not sending", err instanceof Error ? err.message : String(err));
    return false;
  }
}

export function smsMarketingConfigured(): boolean {
  return Boolean(marketingFromNumber() && process.env.TWILIO_ACCOUNT_SID && process.env.JWT_SECRET);
}

export function trackedLink(sendId: string, url: string): string {
  const token = jwt.sign({ sid: sendId, u: url }, String(process.env.JWT_SECRET), { expiresIn: "30d" });
  return `${PUBLIC_URL}/api/r/${token}`;
}

// BF_SERVER_v935_SMS_PLAIN_SEGMENTS - a short tracked link (/api/r/s/<8 characters>), stored so the click still
// marks the send. Falls back to the long signed link if the code cannot be saved.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export async function shortTrackedLink(sendId: string, url: string): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  const { pool } = await import("../db.js");
  for (let attempt = 0; attempt < 3; attempt++) {
    const bytes = randomBytes(8);
    const code = Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
    try {
      const r = await pool.query(`INSERT INTO sms_short_links (code, send_id, url) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING RETURNING code`, [code, sendId, url]);
      if (r.rows?.[0]?.code) return `${PUBLIC_URL}/api/r/s/${code}`;
    } catch (err) {
      console.warn("[marketingSms] short link not saved; using the long link", { message: err instanceof Error ? err.message : String(err) });
      break;
    }
  }
  return trackedLink(sendId, url);
}

export async function sendMarketingSms(to: string, body: string): Promise<{ ok: boolean; sid?: string; optedOut?: boolean; error?: string }> {
  const from = marketingFromNumber();
  if (!from && isTollFreeNumber(fromNumber())) {
    console.error("[marketingSms] not sent: the marketing from-number is toll-free; set TWILIO_SMS_FROM to a Canadian local number");
    return { ok: false, error: "toll_free_sender_not_allowed_for_marketing" };
  }
  if (!from || !to) return { ok: false, error: "no_from_or_to" };
  if (isTollFreeNumber(from) && !(await hasMarketingSmsOptIn(to))) return { ok: false, error: "no_marketing_optin" };
  // BF_SERVER_GUARD_EVERYWHERE_v136 - count junk imported numbers as failures.
  if (isUndeliverableNumber(to)) return { ok: false, error: "undeliverable_number" };
  try {
    const client = fetchTwilioClient();
    const msg = await client.messages.create({ to, from, body, statusCallback: `${PUBLIC_URL}/api/r/status` });
    return { ok: true, sid: (msg as any)?.sid };
  } catch (e: any) {
    if (e?.code === 21610) return { ok: false, optedOut: true, error: "opted_out" };
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

// BF_SERVER_BLOCK_v784_LINE_TYPE_HELPER - Twilio Lookup v2 line type intelligence.
// Returns 'mobile' | 'landline' | 'voip' | 'nonFixedVoip' | ... or null if unknown.
export async function lookupLineType(phone: string): Promise<string | null> {
  if (!phone || !process.env.TWILIO_ACCOUNT_SID) return null;
  try {
    const client = fetchTwilioClient();
    const r: any = await client.lookups.v2.phoneNumbers(phone).fetch({ fields: "line_type_intelligence" });
    const t = r?.lineTypeIntelligence?.type;
    return t ? String(t) : null;
  } catch {
    return null;
  }
}
