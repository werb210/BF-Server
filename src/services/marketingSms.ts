// BF_SERVER_MARKETING_SMS_v1 - bulk marketing SMS via Twilio, with per-recipient
// tracked links (signed token) so clicks drive the fallback cascade. Env-gated on
// a marketing from-number (TWILIO_SMS_FROM, e.g. the toll-free 800 once A2P-verified).
import jwt from "jsonwebtoken";
import { fetchTwilioClient } from "./twilio.js";
import { config } from "../config/index.js";

const PUBLIC_URL = (process.env.PUBLIC_SERVER_URL || "https://server.boreal.financial").replace(/\/+$/, "");

function fromNumber(): string {
  return String(process.env.TWILIO_SMS_FROM || config.twilio.number || config.twilio.phone || "");
}

export function smsMarketingConfigured(): boolean {
  return Boolean(fromNumber() && process.env.TWILIO_ACCOUNT_SID && process.env.JWT_SECRET);
}

export function trackedLink(sendId: string, url: string): string {
  const token = jwt.sign({ sid: sendId, u: url }, String(process.env.JWT_SECRET), { expiresIn: "30d" });
  return `${PUBLIC_URL}/api/r/${token}`;
}

export async function sendMarketingSms(to: string, body: string): Promise<{ ok: boolean; sid?: string; optedOut?: boolean; error?: string }> {
  const from = fromNumber();
  if (!from || !to) return { ok: false, error: "no_from_or_to" };
  try {
    const client = fetchTwilioClient();
    const msg = await client.messages.create({ to, from, body, statusCallback: `${PUBLIC_URL}/api/r/status` });
    return { ok: true, sid: (msg as any)?.sid };
  } catch (e: any) {
    if (e?.code === 21610) return { ok: false, optedOut: true, error: "opted_out" };
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}
