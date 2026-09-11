// BF_SERVER_CALL_REF_v161
// Lets a caller identify a call by either our call_logs UUID or the Twilio
// CallSid.
//
// v145 exposed the disposition workflow beyond the Watch, but only accepts a
// UUID. The dialer never sees one: Twilio hands the client a CallSid, and
// /api/telephony/call-status does not return twilio_call_sid, so there is no
// way to translate. That left the post-call screen unable to record an outcome
// for the call that just ended.

export type CallRefKind = "id" | "sid";

export type CallRef = { kind: CallRefKind; value: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Twilio call sids are "CA" followed by 32 hex characters.
const SID_RE = /^CA[0-9a-f]{32}$/i;

export function parseCallRef(raw: unknown): CallRef | null {
  const value = String(raw ?? "").trim();
  if (UUID_RE.test(value)) return { kind: "id", value };
  if (SID_RE.test(value)) return { kind: "sid", value };
  return null;
}

/**
 * The WHERE clause for the reference. Kept here so the column choice and the
 * parsing cannot drift apart, and so neither is ever built by interpolation.
 */
export function callRefPredicate(ref: CallRef): string {
  return ref.kind === "id" ? "id = $2::uuid" : "twilio_call_sid = $2";
}
