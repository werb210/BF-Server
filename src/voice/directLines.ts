// BF_SERVER_DIRECT_LINES_v688 - every staff member can have their own direct phone number
// (users.direct_number). A call to a direct number rings only that person, then their voicemail;
// calls to any other Boreal number (the 866 main line) go to the receptionist. Staff outbound
// calls show their own direct number when they have one.
type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** "+1 (825) 451-1768", "8254511768" -> "+18254511768"; anything unusable -> null. */
export function e164(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/[^0-9]/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length >= 11 && digits.length <= 15 && String(raw ?? "").trim().startsWith("+")) return "+" + digits;
  return null;
}

export type DirectLineOwner = { userId: string; identity: string; name: string };

/** The active staff member whose direct number was dialled, or null for a main / shared number. */
export async function staffForDirectNumber(q: Q, to: unknown): Promise<DirectLineOwner | null> {
  const number = e164(to);
  if (!number) return null;
  const { rows } = await q.query(
    `SELECT u.id::text AS user_id, u.first_name, u.last_name, sp.twilio_identity
       FROM users u LEFT JOIN staff_presence sp ON sp.user_id = u.id
      WHERE u.direct_number = $1 AND coalesce(u.active, true) = true
      LIMIT 1`, [number]);
  const r = rows[0];
  if (!r) return null;
  const name = [r.first_name, r.last_name].map((p: unknown) => String(p ?? "").trim()).filter(Boolean).join(" ") || "your contact";
  return { userId: r.user_id, identity: String(r.twilio_identity || r.user_id), name };
}

/** The number a staff member's outbound calls should show, or null to use the company default. */
export async function directNumberFor(q: Q, userId: unknown): Promise<string | null> {
  if (!userId) return null;
  const { rows } = await q.query(`SELECT direct_number FROM users WHERE id::text = $1 LIMIT 1`, [String(userId)]);
  return e164(rows[0]?.direct_number) ?? null;
}

/** The 866 main line: the caller ID for staff who have no direct number of their own. */
export function mainLineNumber(): string {
  return e164(process.env.TWILIO_MAIN_LINE_NUMBER) ?? "+18666318939";
}

/** Caller ID for a staff member's outbound call: their direct number, else the 866 main line. */
export async function callerIdForUser(q: Q, userId: unknown): Promise<string> {
  try {
    return (await directNumberFor(q, userId)) ?? mainLineNumber();
  } catch (err: any) {
    console.warn("[voice] direct number lookup failed", { message: err?.message });
    return mainLineNumber();
  }
}

// BF_SERVER_v969_CALLER_ID_PER_BUSINESS - a business can have its own outgoing line. A call made on the Insurance
// or Keystone side of the portal or dialler shows that business's number; a business with no line of its own keeps
// the rule above (the caller's direct number, else the 866). Lines are kept in `settings` as `silo_line.<SILO>`
// so adding one needs no server variable. Boreal Financial has no line here on purpose: staff direct numbers stay.
const LINE_KEY = (silo: string) => "silo_line." + silo;
export const LINE_SILOS = ["BI", "SLF", "KS"] as const;
const lineCache = new Map<string, { at: number; number: string | null }>();
export const clearSiloLineCache = (): void => lineCache.clear();

export async function siloLineNumber(q: Q, silo: unknown): Promise<string | null> {
  const s = String(silo ?? "").trim().toUpperCase();
  if (!(LINE_SILOS as readonly string[]).includes(s)) return null;
  const hit = lineCache.get(s);
  if (hit && Date.now() - hit.at < 60_000) return hit.number;
  const { rows } = await q.query(`SELECT value FROM settings WHERE key = $1 LIMIT 1`, [LINE_KEY(s)]);
  const number = e164(rows[0]?.value) ?? null;
  lineCache.set(s, { at: Date.now(), number });
  return number;
}

export async function setSiloLineNumber(q: Q, silo: unknown, raw: unknown): Promise<{ silo: string; number: string | null }> {
  const s = String(silo ?? "").trim().toUpperCase();
  if (!(LINE_SILOS as readonly string[]).includes(s)) throw new Error("unknown_business");
  const number = String(raw ?? "").trim() ? e164(raw) : null;
  if (String(raw ?? "").trim() && !number) throw new Error("invalid_number");
  if (number) await q.query(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [LINE_KEY(s), number]);
  else await q.query(`DELETE FROM settings WHERE key = $1`, [LINE_KEY(s)]);
  lineCache.delete(s);
  return { silo: s, number };
}

export async function listSiloLines(q: Q): Promise<Array<{ silo: string; number: string | null }>> {
  const out: Array<{ silo: string; number: string | null }> = [];
  for (const s of LINE_SILOS) { lineCache.delete(s); out.push({ silo: s, number: await siloLineNumber(q, s) }); }
  return out;
}

/** BF_SERVER_v970_BUSINESS_LINE_INBOUND - the business whose own line was called ("BI", "KS"...), else null. */
export async function siloForLineNumber(q: Q, to: unknown): Promise<string | null> {
  const n = e164(to);
  if (!n) return null;
  for (const s of LINE_SILOS) {
    if ((await siloLineNumber(q, s)) === n) return s;
  }
  return null;
}

/** Caller ID for a call made in a business: that business's own line when it has one, else the staff rule. */
export async function callerIdForCall(q: Q, userId: unknown, silo: unknown): Promise<string> {
  try {
    const line = await siloLineNumber(q, silo);
    if (line) return line;
  } catch (err: any) {
    console.warn("[voice] business line lookup failed", { message: err?.message });
  }
  return callerIdForUser(q, userId);
}
