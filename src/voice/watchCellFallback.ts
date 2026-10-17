// BF_SERVER_v820_WATCH_CALLS - one place for "ring the Boreal app first, then the verified cell".
// Since v817 a closed-but-registered dialler counts as reachable, so the old rule (cell only when the app is NOT
// reachable) meant a staff member out with only a cellular Watch + AirPods never got a Boreal call. Staff who opted
// in (verified callback number + an enabled standalone Watch) now get: app identity for ~15 s, then their cell -
// sequentially, never in parallel - with a press-1 screen so the cell's own voicemail can never swallow the call.
type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** How long the Boreal app (iPhone dialler / iPad) rings before the cell is tried. */
export const CLIENT_FIRST_TIMEOUT_SECONDS = 15;
/** How long the cell leg rings (includes the screening prompt). */
export const CELL_RING_TIMEOUT_SECONDS = 25;
/** How long the screening prompt waits for a key. */
export const SCREEN_GATHER_TIMEOUT_SECONDS = 8;

export const RECEPTION_BASE = "/api/webhooks/twilio/reception";

function toE164(raw: unknown): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  if (/^\+[1-9]\d{9,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * The staff member's verified cellular number when (and only when) they opted in to standalone Watch routing:
 * server-verified callback number + an active Watch with standalone_routing_enabled. Otherwise null.
 */
export async function verifiedWatchCell(q: Q, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    const { rows } = await q.query(
      `SELECT u.verified_callback_number AS phone
         FROM users u
        WHERE u.id::text = $1
          AND u.callback_verified_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM watch_devices wd WHERE wd.staff_user_id=u.id AND wd.revoked_at IS NULL
                        AND wd.standalone_routing_enabled=true)
        LIMIT 1`,
      [String(userId)],
    );
    return toE164(rows[0]?.phone);
  } catch (err: any) {
    console.warn("[watch_cell] fallback lookup failed", { userId, message: err?.message });
    return null;
  }
}

/** "+14035550142" -> "4 0 3, 5 5 5, 0 1 4 2" so Polly reads digits, not a large number. */
export function spokenNumber(raw: string): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length === 10) return [ten.slice(0, 3), ten.slice(3, 6), ten.slice(6)].map((p) => p.split("").join(" ")).join(", ");
  return ten.split("").join(" ") || "an unknown number";
}

/** CRM name for a phone number (read-only; never creates a contact). */
export async function contactForPhone(q: Q, phone: string | null | undefined): Promise<{ id: string; name: string } | null> {
  const last10 = String(phone ?? "").replace(/\D/g, "").slice(-10);
  if (last10.length !== 10) return null;
  try {
    const { rows } = await q.query(
      `SELECT id::text AS id,
              NULLIF(TRIM(COALESCE(NULLIF(TRIM(name), ''), TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')))), '') AS name
         FROM contacts
        WHERE phone IS NOT NULL
          AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1
          AND merged_into_id IS NULL
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT 1`,
      [last10],
    );
    const r = rows[0];
    if (!r?.id) return null;
    return { id: String(r.id), name: r.name ? String(r.name) : "" };
  } catch (err: any) {
    console.warn("[watch_cell] contact lookup failed", { message: err?.message });
    return null;
  }
}

/** What the screen says for a caller: their CRM name, the app caller's label, else the digits. */
export async function callerLabel(q: Q, from: string | null | undefined): Promise<string> {
  const raw = String(from ?? "").trim();
  if (!raw) return "an unknown number";
  if (/^client:/i.test(raw)) {
    try {
      const { resolveClientIdentityCaller } = await import("../modules/voice/voicemailEnrich.service.js");
      const r = await resolveClientIdentityCaller(raw);
      return r?.label || "the Boreal app";
    } catch (err: any) {
      console.warn("[watch_cell] client identity label failed", { message: err?.message });
      return "the Boreal app";
    }
  }
  const contact = await contactForPhone(q, raw);
  return contact?.name || spokenNumber(raw);
}

/** Twilio <Number url> for the screened cell leg. The caller number is server-set and covered by the signature. */
export function screenUrl(from: string | null | undefined): string {
  const f = String(from ?? "").trim();
  return `${RECEPTION_BASE}/screen${f ? `?from=${encodeURIComponent(f)}` : ""}`;
}

/** The app leg ended without being answered (so the cell may be tried). */
export function dialWasNotAnswered(dialCallStatus: unknown): boolean {
  const s = String(dialCallStatus ?? "").trim().toLowerCase();
  return s !== "completed" && s !== "answered";
}

/** The caller already hung up - nothing more to dial. */
export function callerHungUp(body: Record<string, unknown> | undefined): boolean {
  const s = String(body?.CallStatus ?? "").trim().toLowerCase();
  return s === "completed" || s === "canceled";
}
