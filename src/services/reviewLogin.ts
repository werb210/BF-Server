// BF_SERVER_REVIEW_LOGIN_v710 - store-review sign-in for the Boreal Financial app.
// Google Play (and Apple) reviewers cannot receive our text codes, so one
// configured test number skips the text and accepts one configured code.
// Both come from App Service settings (REVIEW_LOGIN_PHONE, REVIEW_LOGIN_CODE);
// with either unset the bypass is off. The number signs in as an ordinary
// applicant (never staff or lender), so it only ever sees its own applications.
import { timingSafeEqual } from "node:crypto";

function e164(raw: string): string {
  const d = String(raw ?? "").replace(/[^0-9]/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return "";
}

function configured(): { phone: string; code: string } | null {
  const phone = e164(process.env.REVIEW_LOGIN_PHONE ?? "");
  const code = String(process.env.REVIEW_LOGIN_CODE ?? "").trim();
  if (!phone || !/^[0-9]{6}$/.test(code)) return null;
  return { phone, code };
}

export function isReviewPhone(phone: string | null | undefined): boolean {
  const c = configured();
  return Boolean(c && phone && e164(phone) === c.phone);
}

export function reviewCodeMatches(phone: string, code: string): boolean {
  const c = configured();
  if (!c || e164(phone) !== c.phone) return false;
  const a = Buffer.from(String(code ?? "").trim());
  const b = Buffer.from(c.code);
  return a.length === b.length && timingSafeEqual(a, b);
}

// BF_SERVER_STORE_REVIEW_TEST_v734 - anything the Google/Apple reviewers create with the
// review login is a test, not a lead. Their contacts and applications move to silo 'TEST'
// (every staff view, report, alert, SMS audience and Customer Match list is scoped to a
// real silo, so they drop out everywhere) and are tagged store_review. The reviewer's own
// app experience is unchanged: the client app reads its application by id.
export async function quarantineReviewRecords(runQuery: (sql: string, params?: unknown[]) => Promise<unknown>): Promise<boolean> {
  const c = configured();
  if (!c) return false;
  const last10 = c.phone.replace(/[^0-9]/g, "").slice(-10);
  await runQuery(
    `UPDATE contacts
        SET silo = 'TEST',
            tags = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}') || ARRAY['store_review']))),
            updated_at = now()
      WHERE right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = $1
        AND COALESCE(silo, '') <> 'TEST'`,
    [last10],
  );
  await runQuery(
    `UPDATE applications a
        SET silo = 'TEST',
            metadata = COALESCE(a.metadata, '{}'::jsonb) || jsonb_build_object('store_review', true),
            updated_at = now()
      WHERE COALESCE(a.silo, '') <> 'TEST'
        AND (a.contact_id IN (SELECT id FROM contacts WHERE 'store_review' = ANY(COALESCE(tags, '{}')))
             OR a.id IN (SELECT ac.application_id FROM application_contacts ac JOIN contacts ct ON ct.id = ac.contact_id
                          WHERE 'store_review' = ANY(COALESCE(ct.tags, '{}'))))`,
  );
  // Tasks can only belong to a real silo, so the reviewer's tasks are removed from the queues.
  await runQuery(
    `UPDATE tasks SET deleted_at = now(), updated_at = now()
      WHERE deleted_at IS NULL
        AND contact_id IN (SELECT id FROM contacts WHERE 'store_review' = ANY(COALESCE(tags, '{}')))`,
  );
  return true;
}
