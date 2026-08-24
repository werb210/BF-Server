import { type PoolClient } from "pg";
import { pushToUser } from "../../services/notifications/pushToUser.js"; // BF_SERVER_BLOCK_v_NOTIF_PUSH_v1
import { pool, runQuery } from "../../db.js";
// BF_SERVER_SEEDED_NOTIFY_GUARD_v80
// 1,842 of 2,204 notifications in the live table were addressed to the two seeded
// admin accounts - 84% of everything the system has ever raised, unread by
// construction because nobody signs in as them. Among them: inbound SMS from
// clients on live seven-figure applications ("I tried calling you", an appraisal
// contact request) and a lender-question submission. Those were real events that
// nobody was told about.
//
// notifyAllStaff already excluded ...099 but not ...100, which is exactly the kind
// of miss a per-caller fix produces. The guard belongs here, at the single write
// point every notification path funnels through, so a new caller cannot reintroduce
// it. Seeded accounts stay in the users table because the browser dialer stamps
// outbound calls with ...099 (see voiceCalls.ts) - they must exist, but they must
// never be a notification target.
import { SEEDED_ADMIN_ID, SEEDED_ADMIN2_ID } from "../../db/seed.js";
import { logInfo } from "../../observability/logger.js";

const NON_PERSON_USER_IDS = new Set<string>([SEEDED_ADMIN_ID, SEEDED_ADMIN2_ID]);

export function isNonPersonUser(userId: string | null | undefined): boolean {
  return Boolean(userId && NON_PERSON_USER_IDS.has(String(userId)));
}

export type NotificationRecord = {
  id: string;
  user_id: string | null;
  application_id: string | null;
  type: string;
  title: string;
  body: string;
  metadata: unknown | null;
  created_at: Date;
  read_at: Date | null;
};

type Queryable = Pick<PoolClient, "query" | "runQuery">;

export async function createNotification(params: {
  notificationId: string;
  userId: string | null;
  applicationId: string | null;
  type: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown> | null;
  client?: Queryable;
}): Promise<NotificationRecord> {
  // BF_SERVER_SEEDED_NOTIFY_GUARD_v80 - never address a notification to a
  // non-person. Returning a synthetic record keeps every caller's contract intact
  // (they expect a NotificationRecord back) without writing a row nobody reads.
  if (isNonPersonUser(params.userId)) {
    logInfo("notification_skipped_non_person", { userId: params.userId, type: params.type });
    return {
      id: params.notificationId,
      user_id: params.userId,
      application_id: params.applicationId,
      type: params.type,
      title: params.title,
      body: params.body,
      metadata: params.metadata ?? null,
      created_at: new Date(),
      read_at: null,
    };
  }
  const runner = params.client ?? pool;
  const result = await runner.query<NotificationRecord>(
    `insert into notifications
     (id, user_id, application_id, type, title, body, metadata, created_at, read_at)
     values ($1, $2, $3, $4, $5, $6, $7, now(), null)
     returning id, user_id, application_id, type, title, body, metadata, created_at, read_at`,
    [
      params.notificationId,
      params.userId,
      params.applicationId,
      params.type,
      params.title,
      params.body,
      params.metadata ?? null,
    ]
  );
  const record = result.rows[0];
  // BF_SERVER_BLOCK_v_NOTIF_PUSH_v1 - fire an OS system notification for this event
  if (record?.user_id) void pushToUser(record.user_id, record.title ?? "", record.body ?? "");
  if (!record) {
    throw new Error("Failed to create notification.");
  }
  return record;
}
