import { type PoolClient } from "pg";
import { pool } from "../../db";

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
  if (!record) {
    throw new Error("Failed to create notification.");
  }
  return record;
}
