import { randomUUID } from "crypto";
import { pool } from "../db";
import { AppError } from "../middleware/errors";

export type PwaSubscription = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  device_type: string;
  created_at: Date;
  updated_at: Date;
};

export type PwaNotification = {
  id: string;
  user_id: string;
  level: string;
  title: string;
  body: string;
  delivered_at: Date;
  acknowledged_at: Date | null;
  payload_hash: string;
};

export async function upsertPwaSubscription(params: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceType: string;
}): Promise<PwaSubscription> {
  const existing = await pool.runQuery<PwaSubscription>(
    `select id, user_id, endpoint, p256dh, auth, device_type, created_at, updated_at
     from pwa_subscriptions
     where endpoint = $1
     limit 1`,
    [params.endpoint]
  );
  const row = existing.rows[0];
  if (row && row.user_id !== params.userId) {
    throw new AppError(
      "endpoint_in_use",
      "Subscription endpoint is already registered.",
      409
    );
  }

  if (row) {
    const updated = await pool.runQuery<PwaSubscription>(
      `update pwa_subscriptions
       set p256dh = $1,
           auth = $2,
           device_type = $3,
           updated_at = now()
       where id = $4
       returning id, user_id, endpoint, p256dh, auth, device_type, created_at, updated_at`,
      [params.p256dh, params.auth, params.deviceType, row.id]
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) {
      throw new Error("Failed to update PWA subscription.");
    }
    return updatedRow;
  }

  const created = await pool.runQuery<PwaSubscription>(
    `insert into pwa_subscriptions
     (id, user_id, endpoint, p256dh, auth, device_type, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, now(), now())
     returning id, user_id, endpoint, p256dh, auth, device_type, created_at, updated_at`,
    [
      randomUUID(),
      params.userId,
      params.endpoint,
      params.p256dh,
      params.auth,
      params.deviceType,
    ]
  );
  const createdRow = created.rows[0];
  if (!createdRow) {
    throw new Error("Failed to create PWA subscription.");
  }
  return createdRow;
}

export async function deletePwaSubscription(params: {
  userId: string;
  endpoint: string;
}): Promise<boolean> {
  const result = await pool.runQuery(
    `delete from pwa_subscriptions
     where user_id = $1 and endpoint = $2`,
    [params.userId, params.endpoint]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deletePwaSubscriptionLegacy(endpoint: string): Promise<boolean> {
  const result = await pool.runQuery(
    `delete from pwa_subscriptions
     where endpoint = $1`,
    [endpoint]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listPwaSubscriptionsByUser(
  userId: string
): Promise<PwaSubscription[]> {
  const result = await pool.runQuery<PwaSubscription>(
    `select id, user_id, endpoint, p256dh, auth, device_type, created_at, updated_at
     from pwa_subscriptions
     where user_id = $1
     order by updated_at desc`,
    [userId]
  );
  return result.rows;
}

export async function listPwaSubscriptions(): Promise<PwaSubscription[]> {
  const result = await pool.runQuery<PwaSubscription>(
    `select id, user_id, endpoint, p256dh, auth, device_type, created_at, updated_at
     from pwa_subscriptions
     order by updated_at desc`
  );
  return result.rows;
}

export async function deletePwaSubscriptionByEndpoint(params: {
  userId: string;
  endpoint: string;
}): Promise<void> {
  await pool.runQuery(
    `delete from pwa_subscriptions
     where user_id = $1 and endpoint = $2`,
    [params.userId, params.endpoint]
  );
}

export async function createPwaNotificationAudit(params: {
  userId: string;
  level: string;
  title: string;
  body: string;
  deliveredAt: Date;
  payloadHash: string;
  duplicateWindowSeconds?: number;
}): Promise<PwaNotification> {
  const duplicateWindowSeconds = params.duplicateWindowSeconds ?? 120;
  const existing = await pool.runQuery<PwaNotification>(
    `select id, user_id, level, title, body, delivered_at, acknowledged_at, payload_hash
     from pwa_notifications
     where user_id = $1
       and payload_hash = $2
     order by delivered_at desc
     limit 1`,
    [params.userId, params.payloadHash]
  );
  const latest = existing.rows[0];
  if (latest) {
    const cutoff = Date.now() - duplicateWindowSeconds * 1000;
    if (new Date(latest.delivered_at).getTime() >= cutoff) {
      return latest;
    }
  }

  const result = await pool.runQuery<PwaNotification>(
    `insert into pwa_notifications
     (id, user_id, level, title, body, delivered_at, acknowledged_at, payload_hash)
     values ($1, $2, $3, $4, $5, $6, null, $7)
     returning id, user_id, level, title, body, delivered_at, acknowledged_at, payload_hash`,
    [
      randomUUID(),
      params.userId,
      params.level,
      params.title,
      params.body,
      params.deliveredAt,
      params.payloadHash,
    ]
  );
  const notification = result.rows[0];
  if (!notification) {
    throw new Error("Failed to create PWA notification.");
  }
  return notification;
}

export async function listPwaNotificationsForUser(params: {
  userId: string;
  limit: number;
  offset: number;
}): Promise<{ notifications: PwaNotification[]; total: number }> {
  const [result, countResult] = await Promise.all([
    pool.runQuery<PwaNotification>(
      `select id, user_id, level, title, body, delivered_at, acknowledged_at, payload_hash
       from pwa_notifications
       where user_id = $1
       order by delivered_at desc
       limit $2
       offset $3`,
      [params.userId, params.limit, params.offset]
    ),
    pool.runQuery<{ count: number }>(
      `select count(*)::int as count
       from pwa_notifications
       where user_id = $1`,
      [params.userId]
    ),
  ]);
  return {
    notifications: result.rows,
    total: countResult.rows[0]?.count ?? 0,
  };
}

export async function acknowledgePwaNotification(params: {
  userId: string;
  notificationId: string;
}): Promise<boolean> {
  const result = await pool.runQuery(
    `update pwa_notifications
     set acknowledged_at = now()
     where id = $1 and user_id = $2 and acknowledged_at is null`,
    [params.notificationId, params.userId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function purgeOldPwaNotifications(retentionDays: number): Promise<number> {
  const result = await pool.runQuery(
    `delete from pwa_notifications
     where delivered_at < now() - ($1::text || ' days')::interval`,
    [retentionDays]
  );
  return result.rowCount ?? 0;
}
