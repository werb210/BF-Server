// BF_SERVER_v831_DIALER_POLISH - every CRM contact's number and name for the iPhone's caller ID (Call Directory).
// The dialler built caller ID from the first 200 contacts of the contacts list, so most callers showed as a bare number
// when the app was closed. GET /api/voice/caller-directory returns them all in one compact list.

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** The most labels returned; far more than any silo has today, and well inside what iOS accepts. */
export const CALLER_DIRECTORY_LIMIT = 20000;

/** North American numbers as typed in the CRM -> E.164, else null (international numbers must already be E.164). */
export function directoryE164(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (/^\+[1-9]\d{7,14}$/.test(value.replace(/[\s().-]/g, ""))) return value.replace(/[\s().-]/g, "");
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** The name a person would recognise; placeholders ("(application started)", "Unknown") fall through. */
export function directoryLabel(row: { name?: unknown; first_name?: unknown; last_name?: unknown; company_name?: unknown }): string | null {
  const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
  const name = clean(row.name);
  const usable = (v: string) => v && !/\(application started\)/i.test(v) && !/^unknown\b/i.test(v);
  if (usable(name)) return name.slice(0, 80);
  const person = clean(`${clean(row.first_name)} ${clean(row.last_name)}`);
  if (usable(person)) return person.slice(0, 80);
  const company = clean(row.company_name);
  if (usable(company)) return company.slice(0, 80);
  return null;
}

export async function callerDirectory(q: Q, silo: string): Promise<{ number: string; label: string }[]> {
  const { rows } = await q.query(
    `SELECT c.name, c.first_name, c.last_name, c.company_name, c.phone, c.secondary_phone
       FROM contacts c
      WHERE c.silo = $1 AND c.merged_into_id IS NULL
        AND (COALESCE(c.phone, '') <> '' OR COALESCE(c.secondary_phone, '') <> '')
      ORDER BY c.updated_at DESC NULLS LAST, c.id
      LIMIT ${CALLER_DIRECTORY_LIMIT}`,
    [silo],
  );
  const seen = new Set<string>();
  const out: { number: string; label: string }[] = [];
  for (const row of rows) {
    const label = directoryLabel(row);
    if (!label) continue;
    for (const raw of [row.phone, row.secondary_phone]) {
      const number = directoryE164(raw);
      if (!number || seen.has(number)) continue;
      seen.add(number);
      out.push({ number, label });
    }
  }
  return out;
}
