// BF_SERVER_CALLER_DISPLAY_v148
// Resolves a human name for whoever is on the other end of a call.
export type IdentityKind = "staff" | "client_application" | "client_anonymous" | "pstn" | "unknown";
export type ParsedIdentity = { kind: IdentityKind; ref: string | null; fallback: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Formats a NANP number for display; leaves anything else as dialled. */
export function formatPhoneForDisplay(raw: string): string {
  const value = String(raw || "").trim();
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return value;
}

export function parseIdentity(raw: string | null | undefined): ParsedIdentity {
  const value = String(raw ?? "").trim();
  if (!value) return { kind: "unknown", ref: null, fallback: "Unknown caller" };
  if (value.startsWith("client-anon-")) return { kind: "client_anonymous", ref: null, fallback: "Website visitor" };
  if (value.startsWith("client-")) {
    const ref = value.slice("client-".length);
    return { kind: "client_application", ref: UUID_RE.test(ref) ? ref : null, fallback: "Applicant" };
  }
  if (value.startsWith("+") || /^[0-9()\-\s]{7,}$/.test(value)) return { kind: "pstn", ref: null, fallback: formatPhoneForDisplay(value) };
  if (UUID_RE.test(value)) return { kind: "staff", ref: value, fallback: "Boreal staff" };
  return { kind: "unknown", ref: null, fallback: value };
}

export function nameFromParts(parts: { firstName?: string | null; lastName?: string | null; companyName?: string | null; email?: string | null }): string | null {
  const person = [String(parts.firstName ?? "").trim(), String(parts.lastName ?? "").trim()].filter(Boolean).join(" ").trim();
  if (person) return person;
  const company = String(parts.companyName ?? "").trim();
  if (company) return company;
  const email = String(parts.email ?? "").trim();
  return email || null;
}

export type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** Resolves a supplied or database-backed human-readable caller name. */
export async function resolveDisplayName(db: Queryable, identity: string | null | undefined, provided?: string | null): Promise<string> {
  const parsed = parseIdentity(identity);
  const supplied = String(provided ?? "").trim();
  if (supplied && supplied !== String(identity ?? "").trim()) return supplied;
  try {
    if (parsed.kind === "staff" && parsed.ref) {
      const { rows } = await db.query(`SELECT first_name, last_name, email FROM users WHERE id = $1 LIMIT 1`, [parsed.ref]);
      const name = rows[0] ? nameFromParts({ firstName: rows[0].first_name, lastName: rows[0].last_name, email: rows[0].email }) : null;
      return name ?? parsed.fallback;
    }
    if (parsed.kind === "client_application" && parsed.ref) {
      const { rows } = await db.query(`SELECT c.first_name, c.last_name, a.company_name
           FROM applications a LEFT JOIN contacts c ON c.id = a.contact_id
          WHERE a.id::text = $1 LIMIT 1`, [parsed.ref]);
      const name = rows[0] ? nameFromParts({ firstName: rows[0].first_name, lastName: rows[0].last_name, companyName: rows[0].company_name }) : null;
      return name ?? parsed.fallback;
    }
    if (parsed.kind === "pstn") {
      const digits = String(identity ?? "").replace(/[^0-9]/g, "").slice(-10);
      if (digits.length === 10) {
        const { rows } = await db.query(`SELECT first_name, last_name FROM contacts
            WHERE right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 10) = $1 LIMIT 1`, [digits]);
        const name = rows[0] ? nameFromParts({ firstName: rows[0].first_name, lastName: rows[0].last_name }) : null;
        if (name) return name;
      }
    }
  } catch {
    return parsed.fallback;
  }
  return parsed.fallback;
}
