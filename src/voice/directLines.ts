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
