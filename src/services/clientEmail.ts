// BF_SERVER_CLIENT_EMAIL_RESOLVER_v194
// Transactional client notices resolved the recipient as contacts.email via
// applications.contact_id, and returned "no_client_email" when that column was
// blank. But the portal's Applicant panel renders applications.metadata->'applicant',
// which is where the Step-4 wizard actually writes the borrower's address. So an
// application could show a perfectly good email on screen while every notice
// silently no-opped. Both live rejections on 2026-09-14 failed this way.
//
// One resolver, used by every transactional notice, so the three call sites cannot
// drift apart again. Marketing sends deliberately do NOT use this - those are
// consent-governed and must stay on the CRM contact record only.
import { dbQuery } from "../db.js";
import { logInfo } from "../observability/logger.js";

export type ResolvedClientEmail = {
  email: string | null;
  firstName: string | null;
  source: "contact" | "applicant_metadata" | null;
};

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

// Deliberately permissive: this rejects blanks and obvious non-addresses without
// trying to out-guess a real mail server on what deliverable means.
function looksLikeEmail(v: string): boolean {
  return v.length > 3 && v.includes("@") && !v.startsWith("@") && !v.endsWith("@");
}

export async function resolveClientEmail(applicationId: string): Promise<ResolvedClientEmail> {
  const r = await dbQuery<{
    contact_email: string | null;
    contact_first_name: string | null;
    applicant: any;
  }>(
    `SELECT c.email AS contact_email,
            c.first_name AS contact_first_name,
            COALESCE(a.metadata->'applicant', a.metadata->'borrower') AS applicant
       FROM applications a
       LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE a.id::text = ($1)::text
      LIMIT 1`,
    [applicationId],
  ).catch(() => ({ rows: [] as any[] }));

  const row = r.rows[0];
  if (!row) return { email: null, firstName: null, source: null };

  // The CRM contact is the system of record and wins when it has an address.
  const contactEmail = clean(row.contact_email);
  if (looksLikeEmail(contactEmail)) {
    return {
      email: contactEmail,
      firstName: clean(row.contact_first_name) || null,
      source: "contact",
    };
  }

  // Fall back to the primary applicant the borrower typed into the wizard.
  // Never a secondary party: a decline goes only to the person who applied.
  const applicant = row.applicant ?? {};
  const applicantEmail = clean(
    applicant.email ?? applicant.emailAddress ?? applicant.email_address,
  );
  if (looksLikeEmail(applicantEmail)) {
    logInfo("client_email_from_applicant_metadata", { applicationId });
    return {
      email: applicantEmail,
      firstName:
        clean(applicant.firstName ?? applicant.first_name ?? row.contact_first_name) || null,
      source: "applicant_metadata",
    };
  }

  return { email: null, firstName: clean(row.contact_first_name) || null, source: null };
}
