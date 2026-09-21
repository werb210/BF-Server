// BF_SERVER_DRAFT_PROGRESS_v389
// Two things the wizard's draft saves never did:
//  1. The CRM contact created at OTP is named "Unknown (application started)"
//     and only gets a real name on SUBMIT (applicationCrmMirror). An applicant
//     who typed their name and email on Step 4 and then stopped stayed
//     "Unknown" in the CRM and on the Marketing abandoned list.
//  2. Only the CURRENT step was kept. Anyone who went back a step (or re-opened
//     the draft, which resumes on an earlier step) looked like they never got
//     as far as they did, so Marketing under-reported how far drafts reached.
import { runQuery } from "../db.js";

const PLACEHOLDER_FIRST = "Unknown";
const PLACEHOLDER_LAST = "(application started)";

function stepOf(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : 0;
}

/** The furthest wizard step ever saved: never goes down. 0 when unknown. */
export function furthestStep(existing: Record<string, unknown>, next: Record<string, unknown>): number {
  return Math.max(stepOf(existing.furthestStep), stepOf(existing.currentStep), stepOf(next.currentStep));
}

type Applicant = { firstName?: unknown; lastName?: unknown; fullName?: unknown; email?: unknown } | null | undefined;

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 120) : "";
}

/** First/last/email from the Step 4 applicant block, or null when there is no name yet. */
export function applicantIdentity(applicant: Applicant): { first: string; last: string; email: string } | null {
  if (!applicant || typeof applicant !== "object") return null;
  let first = clean(applicant.firstName);
  let last = clean(applicant.lastName);
  if (!first && !last) {
    const parts = clean(applicant.fullName).split(" ").filter(Boolean);
    first = parts.shift() ?? "";
    last = parts.join(" ");
  }
  const rawEmail = clean(applicant.email).toLowerCase();
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail) ? rawEmail : "";
  if (!first && !last && !email) return null;
  return { first, last, email };
}

/**
 * Fill the draft's linked contact from what the applicant typed. Only replaces
 * the OTP placeholder name and only fills a blank email: a name staff (or an
 * earlier submit) already set is never overwritten. Best-effort.
 */
export async function fillDraftContact(applicationId: string, applicant: Applicant): Promise<void> {
  const who = applicantIdentity(applicant);
  if (!who) return;
  try {
    if (who.first || who.last) {
      await runQuery(
        `UPDATE contacts c
            SET first_name = NULLIF($2, ''),
                last_name  = NULLIF($3, ''),
                name       = btrim($2 || ' ' || $3),
                updated_at = now()
           FROM applications a
          WHERE a.id::text = $1::text
            AND c.id = a.contact_id
            AND (NULLIF(btrim(c.first_name), '') IS NULL OR c.first_name = $4)
            AND (NULLIF(btrim(c.last_name), '') IS NULL OR c.last_name = $5)`,
        [applicationId, who.first, who.last, PLACEHOLDER_FIRST, PLACEHOLDER_LAST],
      );
    }
    if (who.email) {
      await runQuery(
        `UPDATE contacts c
            SET email = $2, updated_at = now()
           FROM applications a
          WHERE a.id::text = $1::text
            AND c.id = a.contact_id
            AND NULLIF(btrim(c.email), '') IS NULL`,
        [applicationId, who.email],
      );
    }
  } catch (error) {
    // A duplicate-email constraint or similar must never fail the draft save.
    console.warn("[draft_contact] fill failed", String(error).slice(0, 200));
  }
}
