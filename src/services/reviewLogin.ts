// BF_SERVER_REVIEW_LOGIN_v710 - store-review sign-in for the Boreal Financial app.
// Google Play (and Apple) reviewers cannot receive our text codes, so one
// configured test number skips the text and accepts one configured code.
// Both come from App Service settings (REVIEW_LOGIN_PHONE, REVIEW_LOGIN_CODE);
// with either unset the bypass is off. The number signs in as an ordinary
// applicant (never staff or lender), so it only ever sees its own applications.
import { timingSafeEqual } from "node:crypto";

function e164(raw: string): string {
  const d = String(raw ?? "").replace(/[^0-9]/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return "";
}

function configured(): { phone: string; code: string } | null {
  const phone = e164(process.env.REVIEW_LOGIN_PHONE ?? "");
  const code = String(process.env.REVIEW_LOGIN_CODE ?? "").trim();
  if (!phone || !/^[0-9]{6}$/.test(code)) return null;
  return { phone, code };
}

export function isReviewPhone(phone: string | null | undefined): boolean {
  const c = configured();
  return Boolean(c && phone && e164(phone) === c.phone);
}

export function reviewCodeMatches(phone: string, code: string): boolean {
  const c = configured();
  if (!c || e164(phone) !== c.phone) return false;
  const a = Buffer.from(String(code ?? "").trim());
  const b = Buffer.from(c.code);
  return a.length === b.length && timingSafeEqual(a, b);
}
