import { randomBytes } from "node:crypto";
import { sendSms } from "../notifications/sms.service.js";

const SILO_LANDING_PATHS: Record<string, string> = {
  BF: "/apply",
  BI: "/bi/apply",
  SLF: "/slf/apply",
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
  const base = (process.env.PUBLIC_APP_URL ?? process.env.FRONTEND_URL ?? "https://bfapp.com").replace(/\/$/, "");
  const picked = silos[0] ?? "BF";
  const path = SILO_LANDING_PATHS[picked] ?? SILO_LANDING_PATHS.BF;
  return `${base}${path}?ref=${encodeURIComponent(refCode)}`;
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
