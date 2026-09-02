import type { Pool } from "pg";
import { pushToUser } from "./pushToUser.js"; // BF_SERVER_BLOCK_v_NOTIF_PUSH_v1
import { safeErr } from "../../lib/safeErr.js";
import { sendSMS } from "../smsService.js";
import { sendWatchNotification, type WatchEventType, type WatchNotificationCategory } from "../../watch/notifications.js";

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
  watch?: {
    category: WatchNotificationCategory;
    eventType: WatchEventType;
    resourceId?: string;
    /** Optional privacy-safe Watch copy; defaults to the normal notification copy. */
    title?: string;
    body?: string;
  };
};

export async function notifyAllStaff(ctx: NotifyAllStaffCtx): Promise<{
  smsSent: number;
  notifsCreated: number;
  recipientCount: number;
}>;
export async function notifyAllStaff(ctx: NotifyAllStaffCtx, dependencies?: {
  pushToUser?: typeof pushToUser;
  sendSMS?: typeof sendSMS;
  sendWatchNotification?: typeof sendWatchNotification;
}): Promise<{ smsSent: number; notifsCreated: number; recipientCount: number }>;
export async function notifyAllStaff(ctx: NotifyAllStaffCtx, dependencies: {
  pushToUser?: typeof pushToUser;
  sendSMS?: typeof sendSMS;
  sendWatchNotification?: typeof sendWatchNotification;
} = {}): Promise<{ smsSent: number; notifsCreated: number; recipientCount: number }> {
  const pushBrowser = dependencies.pushToUser ?? pushToUser;
  const sendText = dependencies.sendSMS ?? sendSMS;
  const sendWatch = dependencies.sendWatchNotification ?? sendWatchNotification;
  const silo = ctx.silo ?? "BF";

  // "All staff" per V1 spec: Admin + Staff + Marketing roles, BF silo, active.
  const recipients = await ctx.pool
    .query<{ id: string; phone_number: string | null; email: string | null }>(
      // BF_SERVER_RESTORE_ADMIN_NOTIFY_v91
      // v60 and v80 both excluded these two ids on the belief that they were
      // synthetic. They are not. The users table shows:
      //   00000000-...-099  todd.w@boreal.financial     Admin
      //   00000000-...-100  andrew.p@boreal.financial   Admin
      // They are the real admin logins, seeded with fixed UUIDs at setup. The
      // "unread by construction" reasoning came from push_no_subscriptions in
      // the logs, which only means neither has registered a BROWSER for push -
      // not that nobody reads them.
      //
      // With both excluded, "all staff" resolved to one Marketing user. Inbound
      // client SMS and shared-mailbox email stopped reaching either owner of the
      // business. No exclusion list here: if an account should not be notified,
      // that belongs on the account (active = false), not in a hardcoded id list
      // that outlives whoever understood why it was written.
      `SELECT id::text AS id, phone_number, email
         FROM users
        WHERE active = true
          AND role IN ('Admin', 'Staff', 'Marketing')
          AND coalesce(silo, 'BF') = $1`,
      [silo],
    )
    .catch(() => ({ rows: [] as Array<{ id: string; phone_number: string | null; email: string | null }> }));

  let smsSent = 0;
  let notifsCreated = 0;

  await Promise.all(
    recipients.rows.map(async (user) => {
      // SMS via Twilio.
      if (!ctx.skipSms && user.phone_number && user.phone_number.trim().length > 0) {
        try {
          const r = await sendText(user.phone_number, ctx.body);
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
        void pushBrowser(user.id, ctx.title ?? humanizeType(ctx.notificationType), ctx.body ?? "", ctx.contextUrl ?? "/"); // BF_SERVER_BLOCK_v_NOTIF_PUSH_v1
      } catch (err) {
        console.warn(`[notifyAllStaff] notification insert failed for user=${user.id}`, safeErr(err));
      }

      if (ctx.watch) {
        try {
          await sendWatch({
            staffUserId: user.id,
            category: ctx.watch.category,
            eventType: ctx.watch.eventType,
            title: ctx.watch.title ?? ctx.title ?? humanizeType(ctx.notificationType),
            body: ctx.watch.body ?? ctx.body,
            resourceId: ctx.watch.resourceId,
          });
        } catch {
          console.warn(JSON.stringify({ event: "watch_push_failed", staffUserId: user.id }));
        }
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
