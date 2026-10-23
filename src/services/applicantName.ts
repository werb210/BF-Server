// BF_SERVER_v851_APPLICANT_NAME - the applicant's name, never the OTP placeholder.
//
// When an applicant verifies their phone to start an application, publicApplication.ts creates the CRM contact as
// "Unknown" "(application started)" so the lead is reachable before they type anything. That placeholder leaked:
// readiness-prefill handed it back to the wizard as the applicant's name, the wizard wrote it into
// applications.metadata.applicant, and signing went out to "Unknown (application started)" even after staff had
// corrected the CRM contact. This module is the one place that knows what a placeholder name is, and the one place
// that resolves a real name for signing (the application's own name first, else the linked CRM contact's, written
// back into metadata.applicant so the portal shows it too).
import { dbQuery } from "../db.js";

export const PLACEHOLDER_FIRST_NAME = "Unknown";
export const PLACEHOLDER_LAST_NAME = "(application started)";
export const APPLICANT_NAME_MISSING = "applicant_name_missing";
export const APPLICANT_NAME_MISSING_MESSAGE = "Add the applicant's name first";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export type PersonName = { first: string | null; last: string | null; full: string };

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** True for the OTP placeholder text ("Unknown", "(application started)", "Unknown (application started)"). */
export function isPlaceholderName(value: unknown): boolean {
  const s = clean(value).toLowerCase();
  if (!s) return false;
  if (s.includes("(application started)")) return true;
  return s === "unknown" || s === "unknown unknown";
}

/** The trimmed name, or null when it is empty or a placeholder. */
export function realName(value: unknown): string | null {
  const s = clean(value);
  if (!s || isPlaceholderName(s)) return null;
  return s.slice(0, 120);
}

function fromParts(firstRaw: unknown, lastRaw: unknown, fullRaw: unknown): PersonName | null {
  const first = realName(firstRaw);
  const last = realName(lastRaw);
  if (first || last) return { first, last, full: [first, last].filter(Boolean).join(" ") };
  const full = realName(fullRaw);
  if (!full) return null;
  const parts = full.split(" ");
  const f = parts.shift() ?? "";
  const l = parts.join(" ");
  return { first: f || null, last: l || null, full };
}

/** The real name on an application's metadata.applicant block, or null when it is empty or the placeholder. */
export function applicantNameFrom(applicant: unknown): PersonName | null {
  if (!applicant || typeof applicant !== "object" || Array.isArray(applicant)) return null;
  const a = applicant as Record<string, unknown>;
  return fromParts(a.firstName ?? a.first_name, a.lastName ?? a.last_name, a.fullName ?? a.name);
}

/** The real name on a CRM contact row (first_name / last_name, else name), or null. */
export function contactNameFrom(row: unknown): PersonName | null {
  if (!row || typeof row !== "object") return null;
  const c = row as Record<string, unknown>;
  return fromParts(c.first_name, c.last_name, c.name);
}

/** A prefill applicant block with placeholder name fields removed; null when nothing is left. */
export function withoutPlaceholderNames(fields: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!fields) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (/^(first_?name|last_?name|full_?name|name)$/i.test(k) && typeof v === "string" && !realName(v)) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export type ApplicantNameResult =
  | { status: "ok"; name: PersonName }
  | { status: "repaired"; name: PersonName }
  | { status: "missing" }
  | { status: "unknown" };

const defaultQ: Q = { query: (sql, params) => dbQuery(sql, params as any[]) };

/**
 * The applicant's real name for signing. metadata.applicant wins; when it is empty or the placeholder, the linked CRM
 * contact's real name is used and written back into metadata.applicant (firstName, lastName, fullName). "missing"
 * means neither has a real name (signing must not go out). "unknown" means the application could not be read: the
 * caller carries on as before.
 */
export async function resolveApplicantName(applicationId: string, q: Q = defaultQ): Promise<ApplicantNameResult> {
  let row: Record<string, any> | undefined;
  try {
    const r = await q.query(
      `SELECT a.metadata->'applicant' AS v851_applicant, -- BF_SERVER_v851_APPLICANT_NAME
              c.first_name AS v851_contact_first, c.last_name AS v851_contact_last, c.name AS v851_contact_name
         FROM applications a
         LEFT JOIN contacts c ON c.id = a.contact_id
        WHERE a.id::text = ($1)::text
        LIMIT 1`,
      [applicationId],
    );
    row = r?.rows?.[0];
  } catch (err) {
    console.warn("[applicant-name] lookup failed", { applicationId, message: err instanceof Error ? err.message : String(err) });
    return { status: "unknown" };
  }
  if (!row) return { status: "unknown" };
  const own = applicantNameFrom(row.v851_applicant);
  if (own) return { status: "ok", name: own };
  const crm = contactNameFrom({ first_name: row.v851_contact_first, last_name: row.v851_contact_last, name: row.v851_contact_name });
  if (!crm) return { status: "missing" };
  try {
    await q.query(
      `UPDATE applications
          SET metadata = jsonb_set(
                COALESCE(metadata, '{}'::jsonb), '{applicant}',
                (CASE WHEN jsonb_typeof(metadata->'applicant') = 'object' THEN metadata->'applicant' ELSE '{}'::jsonb END)
                  || jsonb_build_object('firstName', $2::text, 'lastName', $3::text, 'fullName', $4::text),
                true),
              updated_at = now()
        WHERE id::text = ($1)::text -- BF_SERVER_v851_APPLICANT_NAME write-back`,
      [applicationId, crm.first ?? "", crm.last ?? "", crm.full],
    );
  } catch (err) {
    // The name is still used for this signing; the portal shows it after the next successful write.
    console.warn("[applicant-name] write-back failed", { applicationId, message: err instanceof Error ? err.message : String(err) });
  }
  return { status: "repaired", name: crm };
}
