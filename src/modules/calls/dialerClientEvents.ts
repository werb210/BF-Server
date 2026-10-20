// BF_SERVER_v829_DIALER_RELIABILITY - shape and limits for the dialler's own call events (POST /telephony/client-events).
export type ClientEvent = { event: string; call_ref: string | null; metadata: Record<string, string>; occurred_at: string };

export const MAX_EVENTS = 100;
const MAX_METADATA_KEYS = 20;

/** Keeps well-formed events only: a short name, a parseable time (not in the future by more than a day), string metadata. */
export function normalizeClientEvents(raw: unknown, now = Date.now()): ClientEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: ClientEvent[] = [];
  for (const item of raw.slice(0, MAX_EVENTS)) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const event = typeof e.event === "string" ? e.event.trim().slice(0, 64) : "";
    if (!/^[a-z0-9_.-]+$/i.test(event)) continue;
    const at = Date.parse(String(e.at ?? ""));
    if (!Number.isFinite(at) || at > now + 86_400_000) continue;
    const callRef = typeof e.callRef === "string" && e.callRef.trim() ? e.callRef.trim().slice(0, 64) : null;
    const metadata: Record<string, string> = {};
    if (e.metadata && typeof e.metadata === "object" && !Array.isArray(e.metadata)) {
      for (const [k, v] of Object.entries(e.metadata as Record<string, unknown>).slice(0, MAX_METADATA_KEYS)) {
        if (v === null || v === undefined) continue;
        metadata[k.slice(0, 40)] = String(v).slice(0, 300);
      }
    }
    out.push({ event, call_ref: callRef, metadata, occurred_at: new Date(at).toISOString() });
  }
  return out;
}
