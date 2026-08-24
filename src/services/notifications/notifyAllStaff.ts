import type { Pool } from "pg";
import { SEEDED_ADMIN_ID, SEEDED_ADMIN2_ID } from "../../db/seed.js"; // BF_SERVER_SEED_NOTIF_v60
import { pushToUser } from "./pushToUser.js"; // BF_SERVER_BLOCK_v_NOTIF_PUSH_v1
import { safeErr } from "../../lib/safeErr.js";
import { sendSMS } from "../smsService.js";

// BF_SERVER_BLOCK_1_24_NOTIFICATIONS_TITLE — fallback title when caller didn't pass one.
function humanizeType(type: string): string {
  if (!type) return "Notification";
  return (
    type
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || "Notification"
  );
}

export type NotifyAllStaffCtx = {
  pool: Pool;
  // BF_SERVER_NOTIFY_SKIP_SMS_v1 - when true, create the in-app bell + push only, no staff SMS.
  skipSms?: boolean;
  // Type tag for notification record (e.g. "website_contact" | "website_readiness").
  notificationType: string;
  // Plain-text body used for both SMS and in-app notification.
  body: string;
  // BF_SERVER_BLOCK_1_24_NOTIFICATIONS_TITLE — short heading shown above body in the portal bell.
  // Optional; if omitted, a humanized notificationType is used.
  title?: string;
  // Optional row-level reference for the notification.
  refTable?: string;
  refId?: string;
  // Optional context URL the staff member taps to land on the relevant record.
  contextUrl?: string;
  // Silo to limit the notify scope. Defaults to "BF".
  silo?: string;
};

export async function notifyAllStaff(ctx: NotifyAllStaffCtx): Promise<{
  smsSent: number;
  notifsCreated: number;
  recipientCount: number;
}> {
  const silo = ctx.silo ?? "BF";

  // "All staff" per V1 spec: Admin + Staff + Marketing roles, BF silo, active.
  const recipients = await ctx.pool
    .query<{ id: string; phone_number: string | null; email: string | null }>(
      // BF_SERVER_SEED_NOTIF_v60 - the seeded admin is active, has role Admin
      // and sits in the BF silo, so it matched every fan-out. It is not a
      // person: no one signs in as it, so every notification addressed to it
      // was unread by construction, and every push attempt logged a warning.
      // It is kept in the users table because the browser dialer stamps
      // outbound calls with its id (see voiceCalls.ts).
      `SELECT id::text AS id, phone_number, email
         FROM users
        WHERE active = true
          AND role IN ('Admin', 'Staff', 'Marketing')
          -- BF_SERVER_SEEDED_NOTIFY_GUARD_v80 - this excluded SEEDED_ADMIN_ID only.
          -- seed.ts defines TWO seeded admins and the second was never added, so
          -- every inbound-SMS fan-out went to ...100. Both are excluded now.
          AND id::text <> ALL($2::text[])
          AND coalesce(silo, 'BF') = $1`,
      [silo, [SEEDED_ADMIN_ID, SEEDED_ADMIN2_ID]],
    )
    .catch(() => ({ rows: [] as Array<{ id: string; phone_number: string | null; email: string | null }> }));

  let smsSent = 0;
  let notifsCreated = 0;

  await Promise.all(
    recipients.rows.map(async (user) => {
      // SMS via Twilio.
      if (!ctx.skipSms && user.phone_number && user.phone_number.trim().length > 0) {
        try {
          const r = await sendSMS(user.phone_number, ctx.body);
          if (r && (r as { success?: boolean }).success) smsSent += 1;
          else if (!r) smsSent += 1;
        } catch (err) {
          console.warn(`[notifyAllStaff] sms failed for user=${user.id}`, safeErr(err));
        }
      }

      // In-app notification record.
      try {
        await ctx.pool.query(
          `INSERT INTO notifications
             (id, user_id, type, title, ref_table, ref_id, body, context_url, is_read, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, false, now())
           ON CONFLICT (user_id, ref_table, ref_id, type) DO NOTHING`, // BF_SERVER_NOTIF_ONCONFLICT_v1
          [
            user.id,
            ctx.notificationType,
            // BF_SERVER_BLOCK_1_24_NOTIFICATIONS_TITLE — supply title from caller or derive from type.
            ctx.title ?? humanizeType(ctx.notificationType),
            ctx.refTable ?? null,
            ctx.refId ?? null,
            ctx.body,
            ctx.contextUrl ?? null,
          ],
        );
        notifsCreated += 1;
        void pushToUser(user.id, ctx.title ?? humanizeType(ctx.notificationType), ctx.body ?? "", ctx.contextUrl ?? "/"); // BF_SERVER_BLOCK_v_NOTIF_PUSH_v1
      } catch (err) {
        console.warn(`[notifyAllStaff] notification insert failed for user=${user.id}`, safeErr(err));
      }
    }),
  );

  console.log(
    `[notifyAllStaff] type=${ctx.notificationType} recipients=${recipients.rows.length} smsSent=${smsSent} notifsCreated=${notifsCreated}`,
  );

  return {
    smsSent,
    notifsCreated,
    recipientCount: recipients.rows.length,
  };
}
