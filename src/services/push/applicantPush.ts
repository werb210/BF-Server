// BF_SERVER_APPLICANT_PUSH_v235
// Sends a push to every device of every applicant on an application.
//
// Applicant devices register under the client JWT subject, which is
// "client:<phone>" (src/routes/auth/otp.ts), not a users.id. The old automation
// lookup read applications.user_id - a column that does not exist - so no
// applicant push was ever delivered. Applicants are resolved here exactly the
// way callerOwnsApplication resolves them: application_contacts UNION the
// legacy applications.contact_id, matched on the last 10 phone digits.
import { pool } from "../../db.js";
import { sendClientPush } from "../clientPushService.js";

export type ApplicantPushCategory = "DOCUMENT_REQUEST" | "APPLICATION_UPDATE" | "OFFER_READY";

/** BF-client parseNativeUrl only accepts borealclient:// links (src/native/deepLinks.ts). */
export function applicantDeepLink(categoryId: ApplicantPushCategory, applicationId: string): string {
  if (categoryId === "DOCUMENT_REQUEST") return "borealclient://documents";
  const id = String(applicationId || "").trim();
  return id ? `borealclient://application/${encodeURIComponent(id)}` : "borealclient://home";
}

export async function applicantPushUserIds(applicationId: string): Promise<string[]> {
  try {
    const { rows } = await pool.query<{ user_id: string }>(
      `WITH app_phones AS (
         SELECT right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10) AS p10
           FROM application_contacts ac
           JOIN contacts c ON c.id = ac.contact_id
          WHERE ac.application_id::text = ($1)::text
         UNION
         SELECT right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10) AS p10
           FROM applications a
           JOIN contacts c ON c.id = a.contact_id
          WHERE a.id::text = ($1)::text
       )
       SELECT DISTINCT t.user_id
         FROM client_push_tokens t
         JOIN app_phones p
           ON p.p10 <> ''
          AND right(regexp_replace(coalesce(t.user_id,''),'[^0-9]','','g'),10) = p.p10
        WHERE t.user_id LIKE 'client:%'`,
      [applicationId],
    );
    return rows.map((r) => r.user_id).filter(Boolean);
  } catch (err) {
    console.error(JSON.stringify({
      event: "applicant_push_lookup_failed",
      applicationId,
      message: err instanceof Error ? err.message : String(err),
    }));
    return [];
  }
}

type Sender = typeof sendClientPush;
let sender: Sender = sendClientPush;

const recent = new Map<string, number>();
const DEDUPE_MS = 10 * 60 * 1000;

/** Never throws: a push is a courtesy on top of the SMS and in-app message. */
export async function notifyApplicant(input: {
  applicationId: string;
  categoryId: ApplicantPushCategory;
  title: string;
  body: string;
  dedupeKey?: string;
}): Promise<{ sent: number }> {
  const applicationId = String(input.applicationId || "").trim();
  if (!applicationId) return { sent: 0 };
  const key = `${applicationId}:${input.categoryId}:${input.dedupeKey ?? ""}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last < DEDUPE_MS) return { sent: 0 };
  recent.set(key, now);
  try {
    const userIds = await applicantPushUserIds(applicationId);
    const url = applicantDeepLink(input.categoryId, applicationId);
    let sent = 0;
    for (const userId of userIds) {
      const r = await sender({
        userId,
        title: input.title,
        body: input.body,
        silo: "BF",
        categoryId: input.categoryId,
        url,
        data: { applicationId },
      });
      sent += r.sent;
    }
    return { sent };
  } catch (err) {
    console.error(JSON.stringify({
      event: "applicant_push_failed",
      applicationId,
      categoryId: input.categoryId,
      message: err instanceof Error ? err.message : String(err),
    }));
    return { sent: 0 };
  }
}

/** Test seams. */
export function __resetApplicantPushDedupe(): void {
  recent.clear();
}
export function __setApplicantPushSender(next: Sender | null): void {
  sender = next ?? sendClientPush;
}
