// BF_SERVER_PHONE_LINE_TYPE_v771 - before sending a sign-in code, ask Twilio Lookup (Line Type Intelligence) whether
// the number can receive texts. A landline or a number that does not exist gets a clear message back to the applicant
// instead of a code that never arrives. Fails OPEN: any Lookup error, timeout or unknown type lets the code go out.
// Cost is about one cent per lookup; answers are cached per number for 24 hours. TWILIO_LOOKUP_LINE_TYPE=off disables.
export type TextableResult = { ok: true } | { ok: false; reason: "landline" | "invalid" };

const cache = new Map<string, { at: number; result: TextableResult }>();
const DAY_MS = 24 * 60 * 60 * 1000;

export function lineTypeCheckEnabled(): boolean {
  return String(process.env.TWILIO_LOOKUP_LINE_TYPE ?? "on").trim().toLowerCase() !== "off";
}

/** Interpret a Lookup v2 response body. Exported for tests. */
export function interpretLookup(body: any): TextableResult {
  if (body && body.valid === false) return { ok: false, reason: "invalid" };
  const type = String(body?.line_type_intelligence?.type ?? "").toLowerCase();
  if (type === "landline") return { ok: false, reason: "landline" };
  return { ok: true };
}

export async function checkTextable(phoneE164: string, fetchImpl: typeof fetch = fetch): Promise<TextableResult> {
  if (!lineTypeCheckEnabled()) return { ok: true };
  if (process.env.NODE_ENV === "test" && fetchImpl === fetch) return { ok: true }; // no real network calls from tests
  const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  if (!sid || !token) return { ok: true };
  const hit = cache.get(phoneE164);
  if (hit && Date.now() - hit.at < DAY_MS) return hit.result;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetchImpl(
      `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phoneE164)}?Fields=line_type_intelligence`,
      { headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") }, signal: ctrl.signal },
    ).finally(() => clearTimeout(timer));
    if (!res.ok) {
      console.warn("[phone-line-type] lookup http", res.status);
      return { ok: true };
    }
    const result = interpretLookup(await res.json());
    cache.set(phoneE164, { at: Date.now(), result });
    return result;
  } catch (e) {
    console.warn("[phone-line-type] lookup failed; sending anyway", e instanceof Error ? e.message : String(e));
    return { ok: true };
  }
}

export function _clearLineTypeCache(): void { cache.clear(); }

export const NOT_TEXTABLE_MESSAGES = {
  landline: "That number looks like a landline, which can't receive text messages. Please enter a mobile number.",
  invalid: "We couldn't find that phone number. Please check it and try again.",
} as const;
