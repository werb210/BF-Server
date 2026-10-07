// BF_SERVER_OTP_ABUSE_GUARD_v772
// Oct 7 2026: bots used the public sign-in endpoint to send hundreds of Twilio Verify texts to
// Haiti (+509) and Guatemala (+502) - SMS pumping - and cost about $360. Every check here runs
// BEFORE any paid Twilio call (Lookup or Verify):
//  1. Country: Canada and the US only. "+1" alone is not enough - the North American Numbering
//     Plan also covers about 25 Caribbean and Pacific countries, which are classic pumping targets.
//  2. Per number: at most OTP_DAILY_PER_PHONE codes (default 8) per number per rolling 24 hours.
//  3. Circuit breaker: at most OTP_HOURLY_CAP codes (default 60) across ALL numbers per rolling
//     hour, so bots that rotate IPs and numbers still cannot run up more than a few dollars.
// Staff numbers (checked by the caller) skip 2 and 3 so staff can always sign in during an attack.
// Counters live in memory: they reset on restart and are per instance. That is fine for a damage
// cap; Twilio Fraud Guard and Verify Geo Permissions are the other layers.

// NANP area codes that are NOT Canada or the 50 US states (plus 900 premium-rate).
const NON_CA_US_NANP_AREA_CODES: ReadonlySet<string> = new Set([
  "242", "246", "264", "268", "284", "340", "345", "441", "473", "649", "658", "664", "670",
  "671", "684", "721", "758", "767", "784", "787", "809", "829", "849", "868", "869", "876",
  "939", "900",
]);

export function isAllowedOtpDestination(e164: string): boolean {
  const match = /^\+1(\d{10})$/.exec(String(e164 ?? "").trim());
  if (!match) return false;
  return !NON_CA_US_NANP_AREA_CODES.has(match[1].slice(0, 3));
}

export type OtpGuardRefusal = "unsupported_country" | "otp_phone_daily_limit" | "otp_busy";
export type OtpGuardResult = { ok: true } | { ok: false; reason: OtpGuardRefusal };

export const OTP_GUARD_MESSAGES: Record<OtpGuardRefusal, string> = {
  unsupported_country: "Sign-in codes can only be sent to Canadian or US mobile numbers.",
  otp_phone_daily_limit:
    "Too many codes have been sent to this number today. Please try again tomorrow or call us at 1-866-631-8939.",
  otp_busy:
    "Sign-in codes are paused for a few minutes. Please try again shortly or call us at 1-866-631-8939.",
};

export const OTP_GUARD_STATUS: Record<OtpGuardRefusal, number> = {
  unsupported_country: 400,
  otp_phone_daily_limit: 429,
  otp_busy: 429,
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const perPhone = new Map<string, number[]>();
let allSends: number[] = [];
let breakerLoggedAt = 0;

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function maskPhone(e164: string): string {
  return e164.length > 4 ? "***" + e164.slice(-4) : "***";
}

// Checks the number and, when it passes, records the send. Call it once per code you are about to
// send. trusted=true (a staff number) skips the per-number and hourly caps but is still counted.
export function checkOtpSend(phone: string, opts: { trusted?: boolean; now?: number } = {}): OtpGuardResult {
  if (!isAllowedOtpDestination(phone)) return { ok: false, reason: "unsupported_country" };
  const now = opts.now ?? Date.now();
  allSends = allSends.filter((t) => now - t < HOUR_MS);
  const sent = (perPhone.get(phone) ?? []).filter((t) => now - t < DAY_MS);

  if (!opts.trusted) {
    const hourlyCap = positiveIntEnv("OTP_HOURLY_CAP", 60);
    if (allSends.length >= hourlyCap) {
      if (now - breakerLoggedAt > HOUR_MS / 4) {
        breakerLoggedAt = now;
        console.error("[otp-guard] hourly cap of " + hourlyCap + " sign-in codes reached - new codes paused (possible SMS pumping)");
      }
      return { ok: false, reason: "otp_busy" };
    }
    if (sent.length >= positiveIntEnv("OTP_DAILY_PER_PHONE", 8)) {
      perPhone.set(phone, sent);
      console.warn("[otp-guard] daily per-number cap reached for " + maskPhone(phone));
      return { ok: false, reason: "otp_phone_daily_limit" };
    }
  }

  sent.push(now);
  perPhone.set(phone, sent);
  allSends.push(now);
  if (perPhone.size > 5000) {
    for (const [key, times] of perPhone) {
      if (!times.some((t) => now - t < DAY_MS)) perPhone.delete(key);
    }
  }
  return { ok: true };
}

export function _resetOtpGuard(): void {
  perPhone.clear();
  allSends = [];
  breakerLoggedAt = 0;
}
