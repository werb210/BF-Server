// SECURITY_SWEEP_2026_11_19 - Twilio credentials are only ever sent to Twilio's own API host.
export function isTwilioApiUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === "api.twilio.com";
  } catch {
    return false;
  }
}
