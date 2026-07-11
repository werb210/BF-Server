import { randomBytes } from "node:crypto";
import { sendSms } from "../notifications/sms.service.js";

// BF_SERVER_REFERRAL_LANDING_v2 - referrals go to funding (BF) and/or PGI (BI) only.
const SILO_LANDING_PATHS: Record<string, string> = {
  BF: "/apply",
  BI: "/bi/apply",
};

export function mintReferralCode(): string {
  return `BF-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export function normalizeReferralSilos(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const cleaned = raw.map((v) => String(v).trim().toUpperCase()).filter((v) => v in SILO_LANDING_PATHS);
  return [...new Set(cleaned)].slice(0, 3);
}

export function referralLandingUrl(silos: string[], refCode: string): string {
  // BF_SERVER_REFERRAL_LANDING_v2 - route to the real website referral landings:
  //   funding only  -> BF-Website  /r/f/<code>
  //   funding + PGI -> BF-Website  /r/b/<code>   ("both" landing)
  //   PGI only      -> BI-Website  /r/<code>
  const bf = (process.env.BF_WEBSITE_URL ?? process.env.WEBSITE_URL ?? "https://www.boreal.financial").replace(/\/$/, "");
  const bi = (process.env.BI_WEBSITE_URL ?? "https://www.boreal.insure").replace(/\/$/, "");
  const set = new Set(silos.map((v) => String(v).trim().toUpperCase()));
  const code = encodeURIComponent(refCode);
  if (set.has("BI") && !set.has("BF")) return `${bi}/r/${code}`;
  if (set.has("BF") && set.has("BI")) return `${bf}/r/b/${code}`;
  return `${bf}/r/f/${code}`;
}

export async function sendReferralInviteSms(params: {
  to: string | null;
  refCode: string;
  silos: string[];
  message: string | null;
  referrerName: string | null;
}): Promise<void> {
  if (!params.to) return;
  const url = referralLandingUrl(params.silos, params.refCode);
  const intro = params.referrerName ? `${params.referrerName} invited you to Business Finance.` : "You were invited to Business Finance.";
  const body = [intro, params.message, url].filter(Boolean).join("\n");
  await sendSms({ to: params.to, message: body });
}
