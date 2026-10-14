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

export function mergeSmsFields(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_match, key) => vars[String(key).toLowerCase()] ?? "");
}

/** Build the exact recipient-facing marketing SMS in one consistent order. */
export function renderMarketingSms(opts: { body: string; vars: Record<string, string>; link?: string | null }): string {
  const mergedBody = mergeSmsFields(opts.body, opts.vars).trim();
  return [mergedBody, opts.link?.trim(), CASL_FOOTER].filter(Boolean).join(" ");
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
