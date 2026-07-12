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

// BF_SERVER_REFERRAL_SMS_COPY_v1 - the referrer portal posts the chosen intro
// VERSION KEY ("A" or "B"), not the copy itself. Previously that key was pasted
// straight into the SMS body, so referrals received a bare line reading "A".
// The copy now lives here, server-side, so it can be reworded without a deploy
// of the portal. DRAFT copy - reword freely.
//   A = warm intro, referrer's name included
//   B = general, no name
export const REFERRAL_SMS_VERSIONS = {
  A: (referrerName: string | null): string =>
    referrerName
      ? `${referrerName} referred you to Boreal Financial. They help businesses like yours get funding fast - mind if they reach out?`
      : `You have been referred to Boreal Financial. They help businesses like yours get funding fast - mind if they reach out?`,
  B: (): string =>
    `You have been referred to Boreal Financial for business funding. Start whenever you are ready - link below.`,
} as const;

// Resolve what the referral actually receives. `message` is a version key when
// it is exactly "A"/"B"; anything else is treated as custom copy and used as-is.
export function referralIntroBody(params: {
  message: string | null;
  referrerName: string | null;
  url: string;
}): string {
  const key = (params.message ?? "").trim().toUpperCase();
  let text: string;
  if (key === "B") text = REFERRAL_SMS_VERSIONS.B();
  else if (key === "A" || key === "") text = REFERRAL_SMS_VERSIONS.A(params.referrerName);
  else text = (params.message ?? "").trim();
  return [text, params.url].filter(Boolean).join("\n");
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
  const body = referralIntroBody({
    message: params.message,
    referrerName: params.referrerName,
    url,
  });
  await sendSms({ to: params.to, message: body });
}
